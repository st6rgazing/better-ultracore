'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { explicitFiles, repoKey } = require('../context');
const handsoff = require('../handsoff');
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
  // A new untracked directory shows as one `dir/` entry: list the files in it.
  const expand = (f) => (f.endsWith('/') ? lines(git(cwd, 'ls-files', '--others', '--exclude-standard', '--', f)) : [f]);
  const dirty = lines(porcelain(cwd)).filter((l) => !was.has(l)).map(pathOf).flatMap(expand);
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

const firstHit = (added, re) => added.find((a) => re.test(a.text));
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

// Lines of a command's output that name one of the files. A file matches by its repo path or any tail of it with a directory
// (a tool run in a subpackage prints shorter paths); a file at the repo root matches by name. The path must start at a boundary.
function outputLinesNaming(output, files) {
  const tails = files.flatMap((f) => {
    const parts = f.split('/');
    return parts.length === 1 ? [f] : parts.slice(0, -1).map((_, i) => parts.slice(i).join('/'));
  });
  const named = (line) => tails.some((t) => {
    for (let i = line.indexOf(t); i >= 0; i = line.indexOf(t, i + 1)) {
      const before = i ? line[i - 1] : ' ';
      const after = line[i + t.length] || ' ';
      if (!/[\w.-]/.test(before) && !/[\w-]/.test(after)) return true;
    }
    return false;
  });
  return output.split('\n').map((l) => l.trim()).filter((l) => l && named(l));
}

// The literal a sweep must leave no trace of: the old half of `"A" to "B"`, a quoted string after a removal verb, or a code-like bare word after one.
// Returns {literal, next} (next is the replacement, when stated) or null when the prompt names no literal.
const REMOVAL = '(?:remove|delete|drop|get rid of|rename|replace|purge|strip)';
const CODE_LIKE = /[._$\d]|[a-z][A-Z]|^[A-Z_]{3,}$/;
function sweepLiteral(prompt) {
  const text = String(prompt || '');
  const { old, next } = copyStrings(text);
  if (old) return { literal: old, next };
  const quoted = text.match(new RegExp(`\\b${REMOVAL}\\b[^.\\n]{0,40}?${QUOTED}`, 'i'));
  if (quoted) return { literal: quoted[1] || quoted[2] || quoted[3], next: null };
  const bare = text.match(new RegExp(`\\b${REMOVAL}\\s+(?:(?:all|every|any|the|each)\\s+)?(?:(?:uses?|references?|instances?|occurrences?|mentions?|traces?|calls?)\\s+(?:of|to)\\s+)?([\\w.$-]{3,})`, 'i'));
  const word = bare && bare[1].replace(/[.-]+$/, '');
  return word && CODE_LIKE.test(word) ? { literal: word, next: null } : null;
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
    // Block only for errors in files this turn changed; anything else was failing before and is not this turn's to fix.
    const mine = outputLinesNaming(`${r.stdout || ''}\n${r.stderr || ''}`, changedFiles(cwd, turn));
    if (!mine.length) return result('typecheck', true, 'failing, but not in a file changed this turn');
    return result('typecheck', false, `${cmd} exit ${r.status}: ${mine.slice(0, 3).join(' | ').slice(0, 300)} (if it failed before your change, say so and finish)`);
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

const TEST_FILE = /(^|\/)(tests?|__tests__|e2e|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[\w-]+\.py$/;
const TEST_OFF = /\b(describe|it|test)\.(skip|only)\b|\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.skip|\bt\.Skip\(/;
const ABOUT_TESTS = /\b(tests?|specs?|e2e|skip|flaky)\b/i;
const CONFLICT = /^(<{7}|>{7}) \S/;
const DEBUGGER = /^\s*debugger\s*;?\s*$/;
const SCRIPT_FILE = /\.([cm]?[jt]sx?|vue|svelte)$/;
const NO_EDIT_INTENTS = ['SHOW', 'HANDSOFF', 'UNDO'];
const QUESTION_WORDS = 25;
const DESTRUCTIVE = /\b(delete|remove|drop|reset|wipe|destroy|erase|overwrite|force|rm|purge|migrat\w*|deploy\w*|publish\w*|push|release|prod(uction)?|rebase|revert)\b/i;
const NARROW_INTENTS = ['EXACT', 'LITERAL'];
const WIDE_FILES = 5;
const WIDE_LINES = 150;

// Checks that run on every turn with a baseline, not tied to a rule. Each id is also a BUC_OFF name. Soft ones give feedback and never block.
const BUILTIN = {
  // After an undo request, every file the previous turn changed must be back to how it was before that turn.
  'undo-restored'({ turn, cwd }) {
    const prev = turn.prevFiles;
    if (turn.intent !== 'UNDO' || !prev || typeof prev !== 'object') return result('undo-restored', true);
    const left = Object.keys(prev).filter((f) => blobNow(cwd, f) !== (prev[f] || null));
    return result('undo-restored', !left.length, `asked to undo, but these still differ from before your last turn: ${left.slice(0, 3).join(', ')}; restore them (git checkout -- <file>, or delete files you created), then answer in text`);
  },
  // Hands-off repo (the prompt hook said so, or it left no intent and the repo is hands-off): an edit prompt must leave the tree alone.
  'handsoff-no-edits'({ turn, cwd }) {
    const prompt = String(turn.prompt || '');
    const gated = turn.intent === 'HANDSOFF' || (turn.intent === undefined && turn.kind === 'edit' && !handsoff.isApply(prompt) && handsoff.active(repoKey(cwd), { root: cwd }));
    if (!gated) return result('handsoff-no-edits', true);
    const changed = [...changedFiles(cwd, turn), ...deletedFiles(cwd, turn)];
    return result('handsoff-no-edits', !changed.length, `this repo is hands-off but files changed: ${changed.slice(0, 3).join(', ')}; restore them, list the exact files, lines and commands instead, and end with: Say 'apply' and I will make these edits.`);
  },
  // A sweep that names a literal must leave none of it in the repo. Lock files are not searched.
  'sweep-residue'({ turn, cwd }) {
    const found = turn.intent === 'SWEEP' ? sweepLiteral(turn.prompt) : null;
    if (!found) return result('sweep-residue', true);
    let out = '';
    try { out = git(cwd, 'grep', '-nIF', '--untracked', '-e', found.literal, '--', '.', ':!*.lock', ':!*-lock.*', ':!go.sum'); } catch { /* exit 1: no hits */ }
    // "foo" to "fooBar": a line that only holds the new name is not residue.
    const hits = lines(out).filter((l) => !found.next || l.split(found.next).join('').includes(found.literal));
    const at = hits.slice(0, 3).map((l) => l.split(':').slice(0, 2).join(':'));
    return result('sweep-residue', !hits.length, `"${found.literal}" still appears in ${hits.length} place${hits.length === 1 ? '' : 's'}: ${at.join(', ')}; fix each, or say in one line why it stays`);
  },
  // Unless the prompt is about tests: no test file removed (a move keeps its file name) and no skip or only marker added to one.
  'no-test-weakening'({ turn, cwd }) {
    if (ABOUT_TESTS.test(String(turn.prompt || ''))) return result('no-test-weakening', true);
    const changed = changedFiles(cwd, turn);
    const kept = new Set(changed.map((f) => path.basename(f)));
    const gone = deletedFiles(cwd, turn).filter((f) => TEST_FILE.test(f) && !kept.has(path.basename(f)));
    if (gone.length) return result('no-test-weakening', false, `test file removed: ${gone.slice(0, 3).join(', ')}; the request did not ask for that, restore it and fix the code instead`);
    const hit = firstHit(addedLines(cwd, turn, changed.filter((f) => TEST_FILE.test(f))), TEST_OFF);
    return result('no-test-weakening', !hit, hit && `test switched off at ${where(hit)}; the request did not ask for that, make it pass instead`);
  },
  // No merge-conflict marker in any added line, and no debugger statement added to a script file.
  'conflict-or-debugger'({ turn, cwd }) {
    const added = addedLines(cwd, turn, changedFiles(cwd, turn));
    const hit = firstHit(added, CONFLICT) || added.find((a) => SCRIPT_FILE.test(a.file) && DEBUGGER.test(a.text));
    return result('conflict-or-debugger', !hit, hit && `${CONFLICT.test(hit.text) ? 'conflict marker' : 'debugger statement'} left at ${where(hit)}; remove it`);
  },
  // Soft. A short edit request answered with a question and no change: nudge to pick a reading. Never for a risky request.
  'ended-with-question'({ turn, cwd, input }) {
    const prompt = String(turn.prompt || '').trim();
    const reply = String((input && input.last_assistant_message) || '').trim();
    const applies = turn.kind === 'edit' && !NO_EDIT_INTENTS.includes(turn.intent) && prompt && prompt.split(/\s+/).length <= QUESTION_WORDS
      && /\?["')\]*_]*$/.test(reply) && !DESTRUCTIVE.test(prompt);
    if (!applies || changedFiles(cwd, turn).length || deletedFiles(cwd, turn).length) return result('ended-with-question', true);
    return result('ended-with-question', false, 'You ended with a question on a short request and changed nothing. Pick the likeliest reading, make that change now, and say in one line what you assumed.');
  },
  // Soft. A request read as "change only what is named" that touched many files or lines: ask for the extras to go or be justified.
  'wide-diff'({ turn, cwd }) {
    if (!NARROW_INTENTS.includes(turn.intent)) return result('wide-diff', true);
    const files = [...new Set([...changedFiles(cwd, turn), ...deletedFiles(cwd, turn)])].filter((f) => !TEST_OR_LOCK.test(f));
    const removed = lines(git(cwd, 'diff', '--numstat', turn.head || 'HEAD')).filter((l) => !TEST_OR_LOCK.test(l.split('\t')[2] || '')).reduce((n, l) => n + (Number(l.split('\t')[1]) || 0), 0);
    const count = addedLines(cwd, turn, files.filter((f) => fs.existsSync(path.join(cwd, f)))).filter((a) => a.text.trim()).length + removed;
    const wide = files.length > WIDE_FILES || count > WIDE_LINES;
    return result('wide-diff', !wide, `${files.length} files and ${count} lines changed for a request that named one thing. Revert what it did not ask for, or say in one line per extra file why it was needed.`);
  },
};

// Runs the given check ids against a turn snapshot; one process, 90s total. `input` is the Stop hook input, for checks that read the reply.
function runChecks(ids, turn, cwd = turn.root || turn.cwd, input = {}) {
  const deadline = Date.now() + TOTAL_MS;
  return [...new Set(ids)].filter((id) => CHECKS[id] || BUILTIN[id]).map((id) => {
    const ms = deadline - Date.now();
    if (ms <= 0) return result(id, true, 'skipped: time budget used');
    try {
      return (CHECKS[id] || BUILTIN[id])({ turn, cwd, input }, ms);
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

module.exports = { configuredCmd, typecheckCmd, CHECKS, BUILTIN, runChecks, checkSession, changedFiles, deletedFiles, turnFiles, addedLines, sweepLiteral, outputLinesNaming };
