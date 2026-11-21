#!/usr/bin/env node
'use strict';
// Builds the held-out real-task set from Claude Code transcripts and git history. See bench/README.md.
// Source repos are only read (rev-list, diff, clone from); nothing is ever written to them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { rng } = require('./stats');
const { redact } = require('../lib/prefs/redact');

const TEMP_DIR = /(^|-)(tmp|private-tmp|var-folders|bench|scratch|worktrees)(-|$)/;
const HARNESS = /^\s*<|system-reminder|^\s*\[Request interrupted|^\/\w|^Caveat:|^This session is being continued|^(Task|Background) \(from the session that started this one\)/;
// A reminder the harness puts in front of what the user typed (linked-session status and the like).
const LEADING_REMINDER = /^\s*(<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Same cue and length limit as lib/rules/mine.js: what the rule miner could see.
const CUE = /^\s*(no\b|nope|don'?t|do not|stop|still|undo|revert|wrong|not working|i said|only|always|never|that'?s not|why did you|you (changed|didn'?t|forgot))|\b(not working|doesn'?t work|still (broken|not|fails?)|i (said|asked)|only (the|what)|too much|again)\b/i;
const MINER_MAX_LEN = 240;
const UI_FILE = /\.(css|scss|tsx|jsx|vue|svelte|html)$/;

const unescape = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Human messages relayed into a session by a project channel: <message trigger="true" from="human" ...>text</message>.
function relayed(text) {
  const out = [];
  const re = /<message\b([^>]*)>([\s\S]*?)<\/message>/g;
  let m;
  while ((m = re.exec(text))) if (/trigger="true"/.test(m[1]) && /from="human"/.test(m[1])) out.push(unescape(m[2]).trim());
  return out.filter(Boolean);
}

// A message the user typed while the agent was busy: stored as a queued_command attachment, not as a user entry.
function queuedHuman(o) {
  const a = o && o.type === 'attachment' && o.attachment;
  if (!a || a.type !== 'queued_command' || !a.origin || a.origin.kind !== 'human') return null;
  const blocks = typeof a.prompt === 'string' ? [{ type: 'text', text: a.prompt }] : Array.isArray(a.prompt) ? a.prompt : [];
  const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
  return text ? { text, image: blocks.some((b) => b && b.type === 'image') } : null;
}

// One transcript -> ordered user text turns, each with the tool calls made before the next user turn.
// Sidechain, meta, tool-result and harness entries are not turns. Queued messages are turns; one that is
// also stored as a typed entry within two minutes is kept once, as the typed entry. `n` names a turn in ids:
// typed turns count 000, 001, ... as before, queued ones q000, q001, ...
function parseSession(file) {
  const turns = [];
  let cur = null;
  let end = null;
  let typed = 0;
  let queued = 0;
  const twin = (text, ts, isQueued) => turns.find((t) => !!t.queued === isQueued && t.text === text && Math.abs(new Date(ts) - new Date(t.ts)) <= 120000);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.isSidechain) continue;
    const q = queuedHuman(o);
    if (q) {
      if (o.timestamp) end = o.timestamp;
      if (HARNESS.test(q.text) || twin(q.text, o.timestamp, false)) continue;
      cur = { session: o.sessionId || path.basename(file, '.jsonl'), n: `q${String(queued++).padStart(3, '0')}`, queued: true, ts: o.timestamp, text: q.text, cwd: o.cwd || (cur && cur.cwd) || null, branch: o.gitBranch || (cur && cur.branch) || null, image: q.image, tools: 0, edits: 0, commits: 0, spawns: 0 };
      turns.push(cur);
      continue;
    }
    if (!o.message) continue;
    if (o.timestamp) end = o.timestamp;
    const c = o.message.content;
    if (o.type === 'assistant' && cur && Array.isArray(c)) {
      for (const b of c) {
        if (!b || b.type !== 'tool_use') continue;
        cur.tools++;
        if (EDIT_TOOLS.has(b.name)) cur.edits++;
        if (b.name === 'Agent' || b.name === 'Task') cur.spawns++;
        if (b.name === 'Bash' && /\bgit\b[^|;&]*\bcommit\b/.test((b.input && b.input.command) || '')) cur.commits++;
      }
      continue;
    }
    if (o.type !== 'user' || o.isMeta || o.isCompactSummary) continue;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    if (blocks.some((b) => b && b.type === 'tool_result')) continue;
    let text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
    text = text.replace(LEADING_REMINDER, '').trim();
    if (!text) continue;
    const attached = /<wake\b[\s\S]*has-attachments?=|^\s*@"[^"]*\.(png|jpe?g|gif|webp)"/i.test(text);
    if (/<wake\b/.test(text)) {
      const human = relayed(text);
      if (!human.length) continue;
      text = human.join('\n');
    } else if (HARNESS.test(text)) continue;
    const dup = twin(text, o.timestamp, true);
    if (dup) turns.splice(turns.indexOf(dup), 1);
    cur = { session: o.sessionId || path.basename(file, '.jsonl'), n: String(typed++).padStart(3, '0'), ts: o.timestamp, text, cwd: o.cwd || null, branch: o.gitBranch || null, image: attached || blocks.some((b) => b && b.type === 'image') || /\[Image #\d+\]/.test(text), tools: dup ? dup.tools : 0, edits: dup ? dup.edits : 0, commits: dup ? dup.commits : 0, spawns: dup ? dup.spawns : 0 };
    turns.push(cur);
  }
  turns.forEach((t, i) => { t.idx = i; });
  return { turns, end };
}

// Top-level transcripts of real projects; temp, bench and scratch project dirs are skipped, nested subagent files never visited.
function transcripts(root, skip = []) {
  const out = [];
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root).sort() : []) {
    if (TEMP_DIR.test(dir) || skip.some((s) => dir.includes(s))) continue;
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full).sort()) if (f.endsWith('.jsonl')) out.push(path.join(full, f));
  }
  return out;
}

const git = (repo, ...args) => {
  const p = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return p.status === 0 ? p.stdout.trim() : '';
};

const repoCache = new Map();
// The repo a turn ran in: git top level of its cwd, or null when the dir is gone or not a repo.
function repoOf(cwd) {
  if (!cwd) return null;
  if (!repoCache.has(cwd)) repoCache.set(cwd, fs.existsSync(cwd) ? git(cwd, 'rev-parse', '--show-toplevel') || null : null);
  return repoCache.get(cwd);
}

// SHAs by timestamp on one ref. base: last commit before P. wrong: first commit between P and C.
// fix: last commit after C and before N. done: last commit after P and before C (what a control keeps).
function resolveShas(repo, ref, p, c, n) {
  const last = (before) => git(repo, 'rev-list', '-1', `--before=${before}`, ref);
  const when = (sha) => (sha ? new Date(git(repo, 'show', '-s', '--format=%cI', sha)).getTime() : 0);
  const base = last(p) || null;
  const between = git(repo, 'rev-list', '--reverse', `--after=${p}`, `--before=${c}`, ref).split('\n').filter(Boolean);
  const wrong = between[0] || null;
  const done = between[between.length - 1] || null;
  let fix = n ? last(n) || null : null;
  if (fix && when(fix) <= new Date(c).getTime()) fix = null;
  return { base, wrong, fix, done };
}

// Size and files of a diff between two commits.
function diffStat(repo, a, b) {
  if (!a || !b) return { lines: null, files: [] };
  const rows = git(repo, 'diff', '--numstat', a, b).split('\n').filter(Boolean).map((l) => l.split('\t'));
  return { lines: rows.reduce((s, [x, y]) => s + (+x || 0) + (+y || 0), 0), files: rows.map((r) => r[2]) };
}

const isCue = (text) => CUE.test(text);
const minerVisible = (text) => text.trim().length <= MINER_MAX_LEN && isCue(text);

// Operational turns: a short go-ahead to deploy, push, commit or continue. They are neither requests nor
// corrections, so pairing looks through them; one between P and C is recorded as an acknowledgement.
const OPS = /^\s*(yes[, ]+|ok(ay)?[, ]+|done[, ]+)?(push|deploy|straight to|go live|ship|merge|commit|build to|try to deploy|relaunched|reconnected|keep|done|ok(ay)?|yes|yep|perfect|go ahead|continue)\b/i;
const isOps = (text) => text.trim().split(/\s+/).length <= 8 && OPS.test(text);

// One candidate: request P, later turn C, SHAs resolved by timestamp. N is the next request after C without a
// correction cue, or the end of the session. `far` marks a C that is not the next request after P.
function candidate(turns, end, P, C, far) {
  const req = turns.filter((t) => !isOps(t.text) || t === C);
  const repo = repoOf(P.cwd);
  let j = req.indexOf(C) + 1;
  while (j < req.length && isCue(req[j].text)) j++;
  const nIdx = j < req.length ? req[j].idx : turns.length;
  const nTs = j < req.length ? req[j].ts : end;
  // Assistant work between P and N: edit tools, commits and subagent spawns (subagents edit out of sight).
  const work = turns.slice(P.idx, nIdx).reduce((n, t) => n + t.edits + t.commits + t.spawns, 0);
  let shas = { base: null, wrong: null, fix: null, done: null };
  let ref = null;
  if (repo) {
    ref = P.branch && git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${P.branch}`) ? P.branch : 'HEAD';
    shas = resolveShas(repo, ref, P.ts, C.ts, nTs);
  }
  const fixStat = repo ? diffStat(repo, shas.base, shas.fix) : { lines: null, files: [] };
  const doneStat = repo ? diffStat(repo, shas.base, shas.done) : { lines: null, files: [] };
  const id = `${P.session.slice(0, 8)}-${P.n}`;
  return {
    id, ...(C.queued || far ? { key: `${id}>${C.n}` } : {}),
    session: P.session, idx: P.idx, turns: turns.length, repo, ref,
    p: { ts: P.ts, text: P.text, image: P.image, tools: P.tools },
    c: { idx: C.idx, ts: C.ts, text: C.text, image: C.image, queued: !!C.queued, cue: isCue(C.text), visible: minerVisible(C.text) },
    ack: C.idx > P.idx + 1, n_ts: nTs, work, ...shas,
    fix_lines: fixStat.lines, fix_files: fixStat.files, done_lines: doneStat.lines, done_files: doneStat.files,
  };
}

// Every pair of consecutive non-operational user turns (P, C) of one session; nothing is filtered here.
function triples(file) {
  const { turns, end } = parseSession(file);
  const req = turns.filter((t) => !isOps(t.text));
  return req.slice(0, -1).map((P, i) => candidate(turns, end, P, req[i + 1], false));
}

// The candidate for two named turns (their `n`) of one session, for a correction that came some requests
// after what it corrects. Its label key is always id>C. Null when either turn is missing or out of order.
function pairAt(file, pN, cN) {
  const { turns, end } = parseSession(file);
  const P = turns.find((t) => t.n === pN);
  const C = turns.find((t) => t.n === cN);
  return P && C && C.idx > P.idx ? candidate(turns, end, P, C, true) : null;
}

// Step 1: candidates from every transcript under root.
function mine(root, { skip = [] } = {}) {
  return transcripts(root, skip).flatMap(triples);
}

// The label of a pair. Pairs are labelled by id; a pair whose C is a queued message or not the next request has
// its own key (id>C), so a label written for another C never applies to it.
const labelOf = (c, labels) => (labels || {})[c.key || c.id];

const words = (text) => text.trim().split(/\s+/).filter(Boolean).length;

// Mechanical proxy for "reads standalone": long enough, and does not open by leaning on the previous turn.
function standalone(text) {
  const t = text.trim();
  if (words(t) < 4) return false;
  return !/^\s*(no\b|nope|still|undo|revert|wrong|not\b|i said|that'?s not|why did you|you |also|and|now|ok|okay|yes|yeah|yep|it|its|it'?s|that|this|these|those|then|same|again|here|done|keep|or)\b/i.test(t);
}

// What the correction says went wrong, by cue: show (wanted text, not edits), wide (did too much or the wrong
// scope), narrow (did too little or it is still not there), else other.
function kindOf(text) {
  const t = text.toLowerCase();
  if (/\b(show|tell) me\b|\bjust (show|tell|explain)\b|\bdon'?t (edit|change|touch) (anything|any)\b|\bundo (ur|your|all|the) changes?\b/.test(t)) return 'show';
  if (/\b(only|just) (the|this|that|for|on|in|change|when|one)\b|^\s*(no[, ]+)?not (the|that|this|all|every|so)\b|\btoo (much|many|big|far|long)\b|didn'?t ask|\bundo\b|\brevert\b|\bback (to|the way)\b|why did you|\bleave\b.*\b(alone|as (it|is))\b|not everything|\bscrap\b|\bremove (that|this|the)\b/.test(t)) return 'wide';
  if (/\bstill\b|\balso\b|as well|everywhere|\bevery(thing)?\b|\ball (of )?the\b|the rest|forgot|missed|missing|not (working|fixed|done|changed|showing)|doesn'?t|nothing (changed|happened)|\bother\b/.test(t)) return 'narrow';
  return 'other';
}

const isUi = (files) => files.some((f) => UI_FILE.test(f));

const STOP = new Set('a an the to of in on for and or it is be this that i u you me my can could would please just make so with at as not no do dont'.split(' '));
const tokens = (text) => new Set(redact(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)));

// Jaccard overlap of two texts after redaction and normalisation.
function jaccard(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

// Most keywords of any single rule found in the text (whole words, simple plural folded).
function keywordHits(text, rules) {
  const t = tokens(text);
  const has = (k) => t.has(k) || t.has(`${k}s`) || (k.endsWith('s') && t.has(k.slice(0, -1)));
  let best = { rule: null, hits: 0 };
  for (const r of rules) {
    const hits = ((r.when && r.when.keywords) || []).filter((k) => has(String(k).toLowerCase())).length;
    if (hits > best.hits) best = { rule: r.id, hits };
  }
  return best;
}

// Leakage, conservative: a correction the miner could see that carries 2 or more keywords of one rule may have
// sourced that rule; so may any correction that nearly repeats a miner-visible one with a keyword hit.
function leaks(cand, rules, visible) {
  const text = cand.c.text;
  const k = keywordHits(text, rules);
  if (cand.c.visible && k.hits >= 2) return `leak: miner-visible, ${k.hits} keywords of ${k.rule}`;
  const both = keywordHits(`${cand.p.text} ${text}`, rules);
  if (both.hits >= 3) return `leak: request and correction carry ${both.hits} keywords of ${both.rule}`;
  for (const v of visible) {
    if (v.session === cand.session && v.idx === cand.c.idx) continue;
    if (keywordHits(v.text, rules).hits >= 1 && jaccard(text, v.text) >= 0.6) return 'leak: near-duplicate of a mined correction';
  }
  return null;
}

// Sessions and turn positions already used by existing bench cases, found by exact prompt or follow-up text.
function usedTurns(cands, caseRoot) {
  const texts = new Set();
  for (const c of fs.existsSync(caseRoot) ? fs.readdirSync(caseRoot) : []) {
    for (const f of ['prompt.txt', 'followup.txt']) {
      const p = path.join(caseRoot, c, f);
      if (fs.existsSync(p)) texts.add(fs.readFileSync(p, 'utf8').trim());
    }
  }
  const used = [];
  for (const c of cands) {
    if (texts.has(c.p.text.trim())) used.push({ session: c.session, idx: c.idx });
    if (texts.has(c.c.text.trim())) used.push({ session: c.session, idx: c.c.idx });
  }
  return used;
}

// Step 2, mechanical criteria shared by correction cases and controls. Returns the reject reason or null.
function rejectCommon(c, ctx) {
  if (!c.repo) return 'no repo for cwd';
  if ((ctx.skipRepos || []).some((r) => c.repo === r || c.repo.startsWith(`${r}/`))) return 'excluded repo';
  if (!ctx.allowTemp && TEMP_DIR.test(c.repo.replace(/[^a-zA-Z0-9]/g, '-'))) return 'temp or bench dir';
  if (c.p.image) return 'P has an image';
  if (words(c.p.text) > 80) return 'P over 80 words';
  if (!standalone(c.p.text)) return 'P not standalone';
  if ((ctx.used || []).some((u) => u.session === c.session && u.idx >= c.idx - 3 && u.idx <= c.c.idx + 3)) return 'within 3 turns of an existing case';
  if (!c.base) return 'no base commit';
  return null;
}

// Correction case: C must be labelled a correction, have its own fix commit, a small diff, and not leak.
function rejectCorrection(c, ctx) {
  const common = rejectCommon(c, ctx);
  if (common) return common;
  if (c.c.image) return 'C has an image';
  if (!c.fix) return 'no fix commit after C';
  if (c.fix === c.base) return 'fix equals base';
  if (!c.work) return 'no assistant edits after P';
  if (c.fix_lines === null || c.fix_lines === 0) return 'empty base..fix';
  const max = ctx.maxLines || 300;
  if (c.fix_lines > max) return `base..fix over ${max} lines`;
  const label = labelOf(c, ctx.labels);
  if (!label) return 'unlabelled';
  if (label.label !== 'correction') return `C is not a correction (${label.label})`;
  return leaks(c, ctx.rules || [], ctx.visible || []);
}

// Control: the request was followed by a commit and the next turn is neither cued nor labelled a correction.
function rejectControl(c, ctx) {
  const common = rejectCommon(c, ctx);
  if (common) return common;
  if (c.c.cue) return 'next turn has a correction cue';
  if (!c.done) return 'no commit before the next turn';
  if (!c.work) return 'no assistant edits after P';
  if (!c.ack) return 'no go-ahead after the request';
  if (c.done_lines === null || c.done_lines === 0) return 'empty base..done';
  if (c.done_lines > 300) return 'base..done over 300 lines';
  const label = labelOf(c, ctx.labels);
  if (!label) return 'unlabelled';
  if (label.label !== 'accepted') return `not an accepted request (${label.label})`;
  return null;
}

// A correction that is itself corrected is not fixed yet. When the pair starting at a candidate's C is also
// labelled a correction, the two are one case: the first keeps its P and C, takes the later fix, and the later
// pair is dropped. Repeats down the chain. Returns the merged candidates and the ids absorbed into each.
function chain(cands, labels) {
  const isCorr = (c) => !!c && (labelOf(c, labels) || {}).label === 'correction';
  const at = new Map(cands.map((c) => [`${c.session}|${c.idx}`, c]));
  const absorbed = new Map();
  const out = [];
  for (const c of cands) {
    if (!isCorr(c) || absorbed.has(c.id)) { out.push(c); continue; }
    let last = c;
    const ids = [];
    for (let next = at.get(`${c.session}|${last.c.idx}`); isCorr(next); next = at.get(`${c.session}|${last.c.idx}`)) {
      ids.push(next.id);
      absorbed.set(next.id, c.id);
      last = next;
    }
    if (!ids.length) { out.push(c); continue; }
    const stat = diffStat(c.repo, c.base, last.fix);
    out.push({ ...c, fix: last.fix, n_ts: last.n_ts, fix_lines: stat.lines, fix_files: stat.files, chain: ids, last_idx: last.c.idx, later: ids.map((id) => at.get(`${c.session}|${cands.find((x) => x.id === id).idx}`).c.text) });
  }
  return { cands: out.filter((c) => !absorbed.has(c.id)), absorbed };
}

// Seeded Fisher-Yates over a copy sorted by id, so the order depends only on the seed and the ids.
function shuffle(items, seed) {
  const a = [...items].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const next = rng(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const DEFAULT_QUOTAS = { total: 12, perRepo: 5, minRepos: 3, nonUi: 4, wide: 2, narrow: 2, show: 1 };

// Step 3: seeded sample within quotas, no hand-picking. Order: shuffled, corrections the miner could not see first.
// Minimum quotas are filled in a fixed order (show, wide, narrow, non-UI, repo spread), then the rest in order.
// A candidate within 3 turns of one already picked (or in avoid) is passed over, so cases never share a thread.
function sample(cands, { seed = 10, quotas = DEFAULT_QUOTAS, skip = [], avoid = [] } = {}) {
  const q = { ...DEFAULT_QUOTAS, ...quotas };
  const order = shuffle(cands, seed).filter((c) => !skip.includes(c.id));
  const pool = [...order.filter((c) => !c.c.visible), ...order.filter((c) => c.c.visible)];
  const picked = [];
  const perRepo = (r) => picked.filter((p) => p.repo === r).length;
  const end = (c) => c.last_idx ?? c.c.idx;
  const near = (a, b) => a.session === b.session && a.idx <= end(b) + 3 && b.idx <= end(a) + 3;
  const take = (pred) => {
    const c = pool.find((x) => !picked.includes(x) && perRepo(x.repo) < q.perRepo && ![...picked, ...avoid].some((y) => near(x, y)) && pred(x));
    if (c && picked.length < q.total) picked.push(c);
    return !!c;
  };
  const fill = (count, pred) => { while (picked.filter(pred).length < count && take(pred)); };
  fill(q.show, (c) => c.kind === 'show');
  fill(q.wide, (c) => c.kind === 'wide');
  fill(q.narrow, (c) => c.kind === 'narrow');
  fill(q.nonUi, (c) => !c.ui);
  while (new Set(picked.map((p) => p.repo)).size < q.minRepos && take((c) => !picked.some((p) => p.repo === c.repo)));
  while (picked.length < q.total && take(() => true));
  return picked;
}

// Rebuilds a state the history does not hold as one commit: a scratch clone at base with the given commits
// cherry-picked in order. Returns the patch from base (binary-safe), or the pick that did not apply.
// The source repo is only cloned from.
function rebuild(repo, base, picks) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'heldout-rebuild-'));
  const work = path.join(parent, 'work');
  try {
    const run = (...args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (run('clone', '--quiet', repo, work).status !== 0) return { error: 'clone failed' };
    const g = (...args) => run('-C', work, '-c', 'user.name=heldout', '-c', 'user.email=heldout@example.com', ...args);
    if (g('checkout', '--quiet', base).status !== 0) return { error: `no base ${base}` };
    for (const sha of picks) {
      if (g('cherry-pick', '--allow-empty', sha).status !== 0) return { error: `${sha} does not apply` };
    }
    const patch = g('diff', '--binary', base, 'HEAD').stdout;
    return { patch, ...diffStat(work, base, 'HEAD') };
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// prompt.txt: the request, verbatim. When it does not stand alone, the user turns before it (c.context,
// oldest first, verbatim) go in front, a blank line between.
const promptText = (c) => [...(c.context || []), c.p.text].join('\n\n');

// Step 4: the mechanical files of a case. accept.sh and solve-notes.md are written by hand afterwards.
// wrong.sh restores the last commit before C, the state the correction reacted to; the first commit after P
// is kept in case.json as first_after_p. A rebuilt state (c.fix_patch, c.wrong_patch: patches from base) has
// no commit of its own: the patch is stored beside the script that applies it and the picks go in case.json.
function writeCase(dir, c, { deps } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const fix = c.control ? c.done : c.fix;
  const wrong = c.control ? null : c.done;
  const put = (name, body, mode) => fs.writeFileSync(path.join(dir, name), body, mode ? { mode } : undefined);
  const checkout = (sha) => `#!/bin/sh\nset -e\ngit -C "$1" checkout --quiet ${sha} -- .\n`;
  const apply = (file) => `#!/bin/sh\nset -e\ngit -C "$1" apply --whitespace=nowarn "$(cd "$(dirname "$0")" && pwd)/${file}"\n`;
  put('prompt.txt', `${promptText(c)}\n`);
  if (!c.control) put('followup.txt', `${c.c.text}\n`);
  const meta = { repo: c.repo, base: c.base, wrong: c.wrong_patch ? null : wrong, first_after_p: c.wrong, fix: c.fix_patch ? null : fix, session: c.session, ts: c.p.ts, control: !!c.control, kind: c.kind || null, ui: !!c.ui };
  if (c.rebuilt) meta.rebuilt = c.rebuilt;
  if ((c.context || []).length) meta.context_turns = c.context.length;
  put('case.json', `${JSON.stringify(meta, null, 2)}\n`);
  put('setup.sh', `#!/bin/sh\nset -e\ngit clone --quiet ${sq(c.repo)} "$1"\ngit -C "$1" checkout --quiet ${c.base}\n${deps ? `sh ${sq(deps)} ${sq(c.repo)} "$1"\n` : ''}`, 0o755);
  if (c.fix_patch) { put('fix.patch', c.fix_patch); put('solve.sh', apply('fix.patch'), 0o755); } else put('solve.sh', checkout(fix), 0o755);
  if (c.wrong_patch) { put('wrong.patch', c.wrong_patch); put('wrong.sh', apply('wrong.patch'), 0o755); } else if (wrong && wrong !== fix) put('wrong.sh', checkout(wrong), 0o755);
}

// Step 6: the dry check of one case in fresh clones. A case is good only when accept fails at base,
// fails at wrong (when there is a wrong.sh) and passes at fix.
function verifyCase(dir) {
  const stage = (script) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'heldout-dry-'));
    const work = path.join(parent, 'work');
    try {
      const sh = (s) => spawnSync('sh', [path.join(dir, s), work], { encoding: 'utf8' });
      const s = sh('setup.sh');
      if (s.status !== 0) return { error: `setup failed: ${(s.stderr || '').slice(0, 200)}` };
      if (script && sh(script).status !== 0) return { error: `${script} failed` };
      return { pass: sh('accept.sh').status === 0 };
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  };
  const base = stage(null);
  const wrong = fs.existsSync(path.join(dir, 'wrong.sh')) ? stage('wrong.sh') : null;
  const fix = stage('solve.sh');
  const error = [base, wrong, fix].map((x) => x && x.error).find(Boolean) || null;
  const out = { case: path.basename(dir), base_fails: base.pass === false, wrong_fails: wrong ? wrong.pass === false : null, fix_passes: fix.pass === true, error };
  out.ok = !error && out.base_fails && out.wrong_fails !== false && out.fix_passes;
  return out;
}

// Step 8: sha256 of every file of every case. Holds ids and hashes only, never task text.
function manifest(root) {
  const cases = {};
  for (const c of fs.readdirSync(root).sort()) {
    const dir = path.join(root, c);
    if (!fs.existsSync(path.join(dir, 'setup.sh'))) continue;
    cases[c] = {};
    for (const f of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile()) cases[c][f] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  }
  return { version: 1, algorithm: 'sha256', cases };
}

// Cases whose files no longer match the manifest (changed, missing or extra).
function checkManifest(root, m) {
  const now = manifest(root).cases;
  const bad = [];
  for (const c of new Set([...Object.keys(m.cases), ...Object.keys(now)])) if (JSON.stringify(m.cases[c] || null) !== JSON.stringify(now[c] || null)) bad.push(c);
  return bad.sort();
}

function parseArgs(argv) {
  const f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) f[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else f._.push(argv[i]);
  }
  return f;
}

const readJsonl = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Everything the criteria need besides the candidate itself.
function context(cands, f) {
  const rules = f.rules && fs.existsSync(f.rules) ? JSON.parse(fs.readFileSync(f.rules, 'utf8')) : [];
  const labels = f.labels && fs.existsSync(f.labels) ? JSON.parse(fs.readFileSync(f.labels, 'utf8')) : {};
  const visible = cands.filter((c) => c.c.visible).map((c) => ({ session: c.session, idx: c.c.idx, text: c.c.text }));
  return { rules, labels, visible, used: f.existing ? usedTurns(cands, f.existing) : [], skipRepos: f['skip-repos'] ? String(f['skip-repos']).split(',') : [], allowTemp: !!f['allow-temp'], maxLines: f['max-lines'] ? parseInt(f['max-lines'], 10) : 300 };
}

// Steps 2 and 3 for both kinds; returns the picks and every reject with its reason.
function select(cands, ctx, { seed = 10, controls = 3, skip = [], quotas } = {}) {
  const rejects = [];
  const tag = (c) => ({ ...c, kind: kindOf(c.c.text), ui: isUi(c.fix_files) });
  const ok = [];
  const merged = chain(cands, ctx.labels || {});
  for (const [id, into] of merged.absorbed) rejects.push({ id, as: 'correction', why: `later correction in the chain of ${into}` });
  for (const c of merged.cands) {
    const why = rejectCorrection(c, ctx) || (c.later || []).map((text) => leaks({ ...c, c: { ...c.c, text, visible: minerVisible(text) } }, ctx.rules || [], ctx.visible || [])).find(Boolean) || null;
    if (why) rejects.push({ id: c.id, as: 'correction', why }); else ok.push(tag(c));
  }
  const picked = sample(ok, { seed, skip, quotas });
  const okCtl = [];
  for (const c of cands) {
    const why = rejectControl(c, ctx);
    if (why) rejects.push({ id: c.id, as: 'control', why }); else okCtl.push({ ...c, control: true, kind: null, ui: isUi(c.done_files), c: { ...c.c, visible: false } });
  }
  const ctl = sample(okCtl, { seed, skip, avoid: picked, quotas: { total: controls, perRepo: controls, minRepos: 2, nonUi: 0, wide: 0, narrow: 0, show: 0 } });
  return { picked, controls: ctl, eligible: ok.length, eligibleControls: okCtl.length, rejects };
}

function main(argv) {
  const f = parseArgs(argv);
  const cmd = f._[0] || 'mine';
  if (cmd === 'mine') {
    const root = f.root || path.join(os.homedir(), '.claude', 'projects');
    const cands = mine(root, { skip: f.skip ? String(f.skip).split(',') : [] });
    fs.mkdirSync(path.dirname(path.resolve(f.out)), { recursive: true });
    fs.writeFileSync(f.out, cands.map((c) => JSON.stringify(c)).join('\n') + (cands.length ? '\n' : ''));
    console.log(`${cands.length} candidates -> ${f.out}`);
  } else if (cmd === 'select') {
    const cands = readJsonl(f.candidates);
    const r = select(cands, context(cands, f), { seed: parseInt(f.seed || '10', 10), controls: parseInt(f.controls || '3', 10), skip: f['skip-ids'] ? String(f['skip-ids']).split(',') : [] });
    console.log(JSON.stringify({ eligible: r.eligible, eligibleControls: r.eligibleControls, picked: r.picked.map((c) => c.id), controls: r.controls.map((c) => c.id) }));
    if (f.out) fs.writeFileSync(f.out, `${JSON.stringify(r, null, 2)}\n`);
  } else if (cmd === 'write') {
    const sel = JSON.parse(fs.readFileSync(f.selection, 'utf8'));
    const name = (prefix, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`;
    sel.picked.forEach((c, i) => writeCase(path.join(f.out, name('ho', i)), c, { deps: f.deps }));
    sel.controls.forEach((c, i) => writeCase(path.join(f.out, name('ho-ctl', i)), c, { deps: f.deps }));
    console.log(`${sel.picked.length} correction cases and ${sel.controls.length} controls -> ${f.out}`);
  } else if (cmd === 'verify') {
    const root = f.dir;
    const names = f.cases ? String(f.cases).split(',') : fs.readdirSync(root).filter((c) => fs.existsSync(path.join(root, c, 'accept.sh'))).sort();
    const res = names.map((c) => verifyCase(path.join(root, c)));
    for (const r of res) console.log(`${r.case}: base fails=${r.base_fails} wrong fails=${r.wrong_fails === null ? 'n/a' : r.wrong_fails} fix passes=${r.fix_passes}${r.error ? ` error=${r.error}` : ''}`);
    process.exitCode = res.every((r) => r.ok) ? 0 : 1;
  } else if (cmd === 'manifest') {
    if (f.check) {
      const bad = checkManifest(f.dir, JSON.parse(fs.readFileSync(f.check, 'utf8')));
      console.log(bad.length ? `changed: ${bad.join(', ')}` : 'manifest matches');
      process.exitCode = bad.length ? 1 : 0;
    } else {
      fs.writeFileSync(f.out, `${JSON.stringify(manifest(f.dir), null, 2)}\n`);
    }
  } else throw new Error(`unknown command: ${cmd}`);
}

module.exports = { chain, isOps, relayed, queuedHuman, parseSession, transcripts, repoOf, resolveShas, diffStat, isCue, minerVisible, candidate, triples, pairAt, mine, words, standalone, kindOf, isUi, jaccard, keywordHits, leaks, usedTurns, labelOf, rejectCommon, rejectCorrection, rejectControl, shuffle, sample, rebuild, promptText, writeCase, verifyCase, manifest, checkManifest, context, select, DEFAULT_QUOTAS };
if (require.main === module) main(process.argv.slice(2));
