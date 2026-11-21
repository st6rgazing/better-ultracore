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
const HARNESS = /^\s*<|system-reminder|^\s*\[Request interrupted|^\/\w|^Caveat:|^This session is being continued/;
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

// One transcript -> ordered user text turns, each with the tool calls made before the next user turn.
// Sidechain, meta, tool-result and harness entries are not turns.
function parseSession(file) {
  const turns = [];
  let cur = null;
  let end = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || !o.message || o.isSidechain) continue;
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
    if (!text) continue;
    const attached = /<wake\b[\s\S]*has-attachments?=|^\s*@"[^"]*\.(png|jpe?g|gif|webp)"/i.test(text);
    if (/<wake\b/.test(text)) {
      const human = relayed(text);
      if (!human.length) continue;
      text = human.join('\n');
    } else if (HARNESS.test(text)) continue;
    cur = { session: o.sessionId || path.basename(file, '.jsonl'), idx: turns.length, ts: o.timestamp, text, cwd: o.cwd || null, branch: o.gitBranch || null, image: attached || blocks.some((b) => b && b.type === 'image') || /\[Image #\d+\]/.test(text), tools: 0, edits: 0, commits: 0, spawns: 0 };
    turns.push(cur);
  }
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

// Every pair of consecutive non-operational user turns (P, C) of one session with SHAs resolved; nothing is
// filtered here. N is the next such turn after C without a correction cue, or the end of the session.
function triples(file) {
  const { turns, end } = parseSession(file);
  const req = turns.filter((t) => !isOps(t.text));
  const out = [];
  for (let i = 0; i + 1 < req.length; i++) {
    const P = req[i];
    const C = req[i + 1];
    const repo = repoOf(P.cwd);
    let j = i + 2;
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
    out.push({
      id: `${P.session.slice(0, 8)}-${String(P.idx).padStart(3, '0')}`,
      session: P.session, idx: P.idx, turns: turns.length, repo, ref,
      p: { ts: P.ts, text: P.text, image: P.image, tools: P.tools },
      c: { idx: C.idx, ts: C.ts, text: C.text, image: C.image, cue: isCue(C.text), visible: minerVisible(C.text) },
      ack: C.idx > P.idx + 1, n_ts: nTs, work, ...shas,
      fix_lines: fixStat.lines, fix_files: fixStat.files, done_lines: doneStat.lines, done_files: doneStat.files,
    });
  }
  return out;
}

// Step 1: candidates from every transcript under root.
function mine(root, { skip = [] } = {}) {
  return transcripts(root, skip).flatMap(triples);
}

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

module.exports = { isOps, relayed, parseSession, transcripts, repoOf, resolveShas, diffStat, isCue, minerVisible, triples, mine, words, standalone, kindOf, isUi, jaccard, keywordHits, leaks, usedTurns };
