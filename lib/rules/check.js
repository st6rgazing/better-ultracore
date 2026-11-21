'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { explicitFiles } = require('../context');
const store = require('./store');

const TOTAL_MS = 90000;
const CMD_MS = 60000;
const MAX_FILE = 200000;
const AI_TRACE = /co-authored-by:.*(claude|anthropic)|generated (with|by) \[?claude|🤖/i;
const ONLY_CUE = /\b(only|just|don'?t touch|do not touch|nothing else|minimal)\b/i;
const NO_COMMIT = /\b(don'?t|do not|no|without) commit/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const TEST_OR_LOCK = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum)$/;

// Check command from explicit user config only, never from prompt text:
// <repo>/.claude/buc.json, then $BUC_HOME/config.json, then package.json scripts.test.
function configuredCmd(root) {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  for (const f of [path.join(root, '.claude', 'buc.json'), path.join(store.home(), 'config.json')]) {
    const c = read(f);
    if (c && typeof c.checkCmd === 'string' && c.checkCmd.trim()) return c.checkCmd.trim();
  }
  const pkg = read(path.join(root, 'package.json'));
  return pkg && pkg.scripts && pkg.scripts.test ? 'npm test' : '';
}

// Typecheck from explicit config or the repo's own package script; never prompt text. autoCheck:false turns it off.
function typecheckCmd(root) {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const conf = read(path.join(root, '.claude', 'buc.json')) || {};
  if (conf.autoCheck === false) return '';
  if (typeof conf.typecheckCmd === 'string' && conf.typecheckCmd.trim()) return conf.typecheckCmd.trim();
  const scripts = (read(path.join(root, 'package.json')) || {}).scripts || {};
  const name = ['typecheck', 'type-check'].find((n) => scripts[n]);
  return name ? `npm run -s ${name}` : '';
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
const lines = (s) => s.split('\n').filter(Boolean);
const porcelain = (cwd) => git(cwd, 'status', '--porcelain');
const pathOf = (line) => line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '');

// Files changed since the baseline: tracked diff vs baseline HEAD plus untracked, minus entries unchanged from the baseline snapshot.
function changedFiles(cwd, base) {
  const was = new Set(lines(base.porcelain || ''));
  const dirty = lines(porcelain(cwd)).filter((l) => !was.has(l)).map(pathOf);
  const committed = base.head ? lines(git(cwd, 'diff', '--name-only', base.head, 'HEAD')) : [];
  return [...new Set([...committed, ...dirty])].filter((f) => fs.existsSync(path.join(cwd, f)) || committed.includes(f));
}

// Added lines as {file, line, text} for the given files, versus the baseline HEAD (untracked files count whole).
function addedLines(cwd, base, files) {
  const out = [];
  const tracked = new Set(lines(git(cwd, 'ls-files')));
  for (const f of files.filter((x) => !tracked.has(x))) {
    const p = path.join(cwd, f);
    if (!fs.existsSync(p) || fs.statSync(p).size > MAX_FILE) continue;
    fs.readFileSync(p, 'utf8').split('\n').forEach((text, i) => out.push({ file: f, line: i + 1, text }));
  }
  const mine = files.filter((x) => tracked.has(x));
  const diff = mine.length ? git(cwd, 'diff', '-U0', base.head || 'HEAD', '--', ...mine) : '';
  let file = '';
  let n = 0;
  for (const l of diff.split('\n')) {
    const h = l.match(/^@@ -\S+ \+(\d+)/);
    if (l.startsWith('+++ ')) file = l.slice(6);
    else if (h) n = Number(h[1]);
    else if (l.startsWith('+')) out.push({ file, line: n++, text: l.slice(1) });
  }
  return out;
}

// Files this turn removed: gone from disk and either deleted in a commit since the baseline or newly shown as deleted.
function deletedFiles(cwd, base) {
  const was = new Set(lines(base.porcelain || ''));
  const dirty = lines(porcelain(cwd)).filter((l) => !was.has(l) && l.slice(0, 2).includes('D')).map(pathOf);
  const committed = base.head ? lines(git(cwd, 'diff', '--name-only', '--diff-filter=D', base.head, 'HEAD')) : [];
  return [...new Set([...committed, ...dirty])].filter((f) => !fs.existsSync(path.join(cwd, f)));
}

// Git blob hash of a file on disk now, or null when it does not exist.
const blobNow = (cwd, f) => (fs.existsSync(path.join(cwd, f)) ? git(cwd, 'hash-object', '--', f).trim() : null);

// Each path the turn changed or removed, mapped to its blob hash at the turn's baseline HEAD (null when it did not exist then).
// This is the `files` entry the Stop hook stores with saveLastTurn, and what undo-restored compares against.
function turnFiles(cwd, base) {
  const out = {};
  for (const f of [...changedFiles(cwd, base), ...deletedFiles(cwd, base)]) {
    let h = null;
    try { h = base.head ? git(cwd, 'rev-parse', '--verify', '--quiet', `${base.head}:${f}`).trim() || null : null; } catch { /* not in the baseline */ }
    out[f] = h;
  }
  return out;
}

const firstHit =(added, re) => added.find((a) => re.test(a.text));
const where = (a) => `${a.file}:${a.line}`;
const result = (id, pass, detail = '') => ({ id, pass, detail });

// `"A" to "B"` (also with, ->, unicode arrow; quotes " ' `) gives old=A, new=B; otherwise the last quoted string is the new one.
const QUOTED = '(?:"([^"\\n]{2,})"|(?<!\\w)\'([^\'\\n]{2,})\'(?!\\w)|`([^`\\n]{2,})`)';
function copyStrings(prompt) {
  const pair = prompt.match(new RegExp(`${QUOTED}\\s*(?:to|with|into|->|\u2192)\\s*${QUOTED}`, 'i'));
  if (pair) return { old: pair[1] || pair[2] || pair[3], next: pair[4] || pair[5] || pair[6] };
  const all = [...prompt.matchAll(new RegExp(QUOTED, 'g'))];
  const last = all[all.length - 1];
  return { old: null, next: last ? last[1] || last[2] || last[3] : null };
}

const CHECKS = {
  'advice-no-edits'({ turn, cwd }) {
    if (turn.kind !== 'advice') return result('advice-no-edits', true);
    const changed = changedFiles(cwd, turn);
    return result('advice-no-edits', !changed.length, `advice prompt but files changed: ${changed.slice(0, 3).join(', ')}`);
  },
  'only-named-files'({ turn, cwd }) {
    if (!ONLY_CUE.test(turn.prompt)) return result('only-named-files', true);
    const named = explicitFiles(cwd, turn.prompt);
    const extra = named.length ? changedFiles(cwd, turn).filter((f) => !named.includes(f) && !TEST_OR_LOCK.test(f)) : [];
    return result('only-named-files', !extra.length, `changed files not named in the request: ${extra.slice(0, 3).join(', ')}`);
  },
  'no-ai-traces'({ turn, cwd }) {
    const msgs = turn.head ? git(cwd, 'log', `${turn.head}..HEAD`, '--format=%B') : '';
    const hit = firstHit(addedLines(cwd, turn, changedFiles(cwd, turn)), AI_TRACE);
    const fail = AI_TRACE.test(msgs) ? 'commit message' : hit && where(hit);
    return result('no-ai-traces', !fail, `AI attribution at ${fail}`);
  },
  'no-emoji'({ turn, cwd }) {
    const hit = firstHit(addedLines(cwd, turn, changedFiles(cwd, turn)), EMOJI);
    return result('no-emoji', !hit, hit && `emoji added at ${where(hit)}`);
  },
  'exact-copy'({ turn, cwd }) {
    const { old, next } = copyStrings(turn.prompt);
    const files = changedFiles(cwd, turn).filter((f) => fs.existsSync(path.join(cwd, f)) && fs.statSync(path.join(cwd, f)).size <= MAX_FILE);
    const texts = files.map((f) => ({ f, t: fs.readFileSync(path.join(cwd, f), 'utf8') }));
    const stale = old && texts.find((x) => x.t.includes(old));
    if (stale) return result('exact-copy', false, `old string still present in ${stale.f}`);
    const missing = next && !texts.some((x) => x.t.includes(next));
    return result('exact-copy', !missing, 'new string not found in changed files');
  },
  'check-cmd'({ turn, cwd }, ms) {
    const cmd = configuredCmd(cwd);
    if (!cmd) return result('check-cmd', true);
    if (!changedFiles(cwd, turn).length) return result('check-cmd', true, 'no files changed');
    const r = spawnSync(cmd, { shell: true, cwd, stdio: 'ignore', timeout: Math.min(CMD_MS, ms) });
    if (r.error && r.error.code !== 'ETIMEDOUT') return result('check-cmd', true, 'skipped');
    if (r.status === 127) return result('check-cmd', true, 'skipped');
    if (r.status === 0) return result('check-cmd', true);
    return result('check-cmd', false, `${cmd}: ${r.error ? 'timed out' : `exit ${r.status}`} after files changed this turn`);
  },
  typecheck({ turn, cwd }, ms) {
    const cmd = typecheckCmd(cwd);
    if (!cmd) return result('typecheck', true);
    if (!changedFiles(cwd, turn).length) return result('typecheck', true, 'no files changed');
    if (fs.existsSync(path.join(cwd, 'package.json')) && !fs.existsSync(path.join(cwd, 'node_modules'))) return result('typecheck', true, 'skipped: no node_modules');
    const r = spawnSync(cmd, { shell: true, cwd, encoding: 'utf8', timeout: Math.min(CMD_MS, ms) });
    if (r.error || r.status === 127) return result('typecheck', true, 'skipped');
    if (r.status === 0) return result('typecheck', true);
    const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-300);
    return result('typecheck', false, `${cmd} exit ${r.status}: ${tail} (if it failed before your change, say so and finish)`);
  },
  'small-commits'({ turn, cwd }) {
    if (!/\bcommit (each|after (each|every)|every)\b/i.test(turn.prompt) || !turn.head) return result('small-commits', true);
    const items = (turn.prompt.match(/^\s*\d+[.)]/gm) || []).length || 2;
    const commits = Number(git(cwd, 'rev-list', '--count', `${turn.head}..HEAD`));
    const dirty = lines(porcelain(cwd)).length;
    return result('small-commits', commits >= items && !dirty, `${commits} commits for ${items} items${dirty ? ', tree not clean' : ''}`);
  },
  // Standing "commit as you go" habit: nothing this turn changed may be left uncommitted. Files dirty before the turn are not counted.
  'commit-changes'({ turn, cwd }) {
    if (turn.kind === 'advice' || !turn.head || NO_COMMIT.test(turn.prompt)) return result('commit-changes', true);
    const was = new Set(lines(turn.porcelain || ''));
    const left = lines(porcelain(cwd)).filter((l) => !was.has(l)).map(pathOf);
    return result('commit-changes', !left.length, `uncommitted changes from this turn: ${left.slice(0, 3).join(', ')}; commit them as small logical commits with plain messages`);
  },
};

// Runs the given check ids against a turn snapshot; one process, 90s total. `input` is the Stop hook input, for checks that read the reply.
function runChecks(ids, turn, cwd = turn.root || turn.cwd, input = {}) {
  const deadline = Date.now() + TOTAL_MS;
  return [...new Set(ids)].filter((id) => CHECKS[id]).map((id) => {
    const ms = deadline - Date.now();
    if (ms <= 0) return result(id, true, 'skipped: time budget used');
    try {
      return CHECKS[id]({ turn, cwd, input }, ms);
    } catch (e) {
      return result(id, true, `skipped: ${e.code || 'git error'}`);
    }
  });
}

// Checks of this session's last turn: the checks of its matched rules, minus any id switched off (BUC_OFF or "off" in .claude/buc.json).
// Returns [] when there is nothing to check. A turn file may lack every field (the tool hook can create one).
function checkSession(sessionId, input = {}) {
  const turn = store.readTurn(sessionId);
  const root = turn && (turn.root || turn.cwd);
  if (!root) return [];
  const ids = (turn.checks || []).filter((id) => !store.off(id, root));
  const rules = turn.rules || [];
  return runChecks(ids, turn, root, input).map((r) => ({ ...r, rules: rules.filter((x) => x.cmd === r.id).map((x) => x.id) }));
}

module.exports = { configuredCmd, typecheckCmd, CHECKS, runChecks, checkSession, changedFiles, deletedFiles, turnFiles, addedLines };
