'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const check = require('../lib/rules/check');
const store = require('../lib/rules/store');

const HOOKS = path.join(__dirname, '..', 'hooks');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const write = (dir, f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };

function repo(files = { 'app.js': 'const label = "old text";\n', 'other.js': 'x\n' }) {
  const dir = tmp('buc-v10-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  for (const [f, s] of Object.entries(files)) write(dir, f, s);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

// Baseline snapshot as the prompt hook records it.
const turn = (dir, prompt, extra = {}) => ({
  session_id: 's', cwd: dir, root: dir, prompt, kind: 'edit', head: git(dir, 'rev-parse', 'HEAD'),
  porcelain: execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), rules: [], checks: [], ...extra,
});
const run = (id, t, input) => check.runChecks([id], t, t.root, input)[0];

// Runs fn with BUC_HOME (and other env) set, restoring the old values after.
function withEnv(env, fn) {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function hook(name, input, home, env = {}) {
  const r = spawnSync('node', [path.join(HOOKS, name)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, BUC_HOME: home, BUC_OFF: '', ...env } });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

test('checkSession reads a bare turn file without throwing and honours BUC_OFF per check', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  withEnv({ BUC_HOME: home, BUC_OFF: '' }, () => {
    store.patchTurn('bare', { toolCalls: 2 });
    assert.deepStrictEqual(check.checkSession('bare'), []);
    store.writeTurn('s', turn(dir, 'tell me how this works', { kind: 'advice', checks: ['advice-no-edits', 'not-a-check'], rules: [{ id: 'r1', cmd: 'advice-no-edits' }] }));
    write(dir, 'app.js', 'changed\n');
    const r = check.checkSession('s').find((x) => x.id === 'advice-no-edits');
    assert.strictEqual(r.pass, false);
    assert.deepStrictEqual(r.rules, ['r1']);
  });
  withEnv({ BUC_HOME: home, BUC_OFF: 'advice-no-edits' }, () => {
    assert.ok(!check.checkSession('s').some((x) => x.id === 'advice-no-edits'));
  });
});

test('deletedFiles lists files removed this turn, committed or not, and not ones deleted before it', () => {
  const dir = repo({ 'a.js': 'a\n', 'b.js': 'b\n', 'c.js': 'c\n' });
  fs.unlinkSync(path.join(dir, 'c.js'));
  const t = turn(dir, 'tidy up');
  assert.deepStrictEqual(check.deletedFiles(dir, t), []);
  fs.unlinkSync(path.join(dir, 'a.js'));
  git(dir, 'rm', '-q', 'b.js');
  git(dir, 'commit', '-qm', 'drop b');
  assert.deepStrictEqual(check.deletedFiles(dir, t).sort(), ['a.js', 'b.js']);
});

test('turnFiles maps changed, created and removed paths to their hash before the turn', () => {
  const dir = repo();
  const t = turn(dir, 'edit things');
  const before = git(dir, 'rev-parse', 'HEAD:app.js');
  write(dir, 'app.js', 'changed\n');
  write(dir, 'new.js', 'n\n');
  fs.unlinkSync(path.join(dir, 'other.js'));
  assert.deepStrictEqual(check.turnFiles(dir, t), { 'app.js': before, 'new.js': null, 'other.js': git(dir, 'rev-parse', 'HEAD:other.js') });
});

test('undo-restored fails until the previous turn\'s files are back, and only on an UNDO turn', () => {
  const dir = repo();
  const first = turn(dir, 'make the label nicer');
  write(dir, 'app.js', 'const label = "nicer";\n');
  write(dir, 'extra.js', 'created\n');
  const prevFiles = check.turnFiles(dir, first);
  const t = turn(dir, 'undo that and just show me', { intent: 'UNDO', prevFiles });
  const r = run('undo-restored', t);
  assert.strictEqual(r.pass, false);
  assert.match(r.detail, /app\.js, extra\.js/);
  assert.strictEqual(run('undo-restored', { ...t, intent: 'MISREAD' }).pass, true);
  assert.strictEqual(run('undo-restored', { ...t, prevFiles: undefined }).pass, true);
  git(dir, 'checkout', '--', 'app.js');
  assert.match(run('undo-restored', t).detail, /differ from before your last turn: extra\.js;/);
  fs.unlinkSync(path.join(dir, 'extra.js'));
  assert.strictEqual(run('undo-restored', t).pass, true);
});

test('handsoff-no-edits blocks edits on a HANDSOFF turn and in a hands-off repo, never an apply', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  withEnv({ BUC_HOME: home, BUC_OFF: '' }, () => {
    const t = turn(dir, 'make the header blue', { intent: 'HANDSOFF' });
    assert.strictEqual(run('handsoff-no-edits', t).pass, true);
    write(dir, 'app.js', 'changed\n');
    const r = run('handsoff-no-edits', t);
    assert.strictEqual(r.pass, false);
    assert.match(r.detail, /app\.js.*Say 'apply'/);
    assert.strictEqual(run('handsoff-no-edits', { ...t, intent: 'SELF' }).pass, true);
    const bare = { ...t, intent: undefined };
    assert.strictEqual(run('handsoff-no-edits', bare).pass, true, 'no intent and no hands-off setting');
    require('../lib/handsoff').set(require('../lib/context').repoKey(dir), 'on');
    assert.strictEqual(run('handsoff-no-edits', bare).pass, false);
    assert.strictEqual(run('handsoff-no-edits', { ...bare, prompt: 'apply' }).pass, true);
    assert.strictEqual(run('handsoff-no-edits', { ...bare, intent: 'SELF' }).pass, true, 'a stated intent wins over the fallback');
  });
});

test('sweepLiteral finds the string a sweep must remove and ignores plain words', () => {
  const lit = (p) => (check.sweepLiteral(p) || {}).literal;
  assert.deepStrictEqual(check.sweepLiteral('rename "Sign in" to "Log in" everywhere'), { literal: 'Sign in', next: 'Log in' });
  assert.strictEqual(lit('remove every "Beta" badge across the whole app'), 'Beta');
  assert.strictEqual(lit('remove all console.log everywhere'), 'console.log');
  assert.strictEqual(lit('get rid of all references to oldApi throughout'), 'oldApi');
  assert.strictEqual(lit('remove every TODO in the repo'), 'TODO');
  assert.strictEqual(lit('remove the unused imports everywhere'), undefined);
  assert.strictEqual(lit('make every page use the new header'), undefined);
});

test('sweep-residue reports up to 3 leftover hits on a SWEEP turn and passes when none remain', () => {
  const dir = repo({ 'a.js': 'log("Sign in");\n', 'b.js': '// Sign in\n', 'c.js': 'x = "Sign in";\n', 'd.js': 'y = "Sign in";\n' });
  const t = turn(dir, 'rename "Sign in" to "Log in" everywhere', { intent: 'SWEEP' });
  write(dir, 'a.js', 'log("Log in");\n');
  const r = run('sweep-residue', t);
  assert.strictEqual(r.pass, false);
  assert.match(r.detail, /"Sign in" still appears in 3 places: b\.js:1, c\.js:1, d\.js:1;/);
  assert.strictEqual(run('sweep-residue', { ...t, intent: 'SELF' }).pass, true);
  assert.strictEqual(run('sweep-residue', { ...t, intent: undefined }).pass, true);
  for (const f of ['b.js', 'c.js', 'd.js']) write(dir, f, 'done\n');
  assert.strictEqual(run('sweep-residue', t).pass, true);
  write(dir, 'new.js', 'untracked "Sign in"\n');
  assert.match(run('sweep-residue', t).detail, /1 place: new\.js:1;/);
});

test('sweep-residue does not count the new name when it contains the old one', () => {
  const dir = repo({ 'a.js': 'const userId = 1;\n', 'b.js': 'use(user);\n' });
  const t = turn(dir, 'rename `user` to `userId` in the whole repo', { intent: 'SWEEP' });
  assert.match(run('sweep-residue', t).detail, /1 place: b\.js:1;/);
  write(dir, 'b.js', 'use(userId);\n');
  assert.strictEqual(run('sweep-residue', t).pass, true);
});

test('no-test-weakening blocks a removed test file or an added skip, unless the prompt is about tests', () => {
  const dir = repo({ 'app.js': 'a\n', 'test/app.test.js': "test('a', () => {});\n", 'test/b.test.js': 'b\n' });
  const t = turn(dir, 'fix the header colour');
  write(dir, 'app.js', 'it.skip is only text here\n');
  assert.strictEqual(run('no-test-weakening', t).pass, true, 'markers outside test files do not count');
  write(dir, 'test/app.test.js', "test.skip('a', () => {});\n");
  const r = run('no-test-weakening', t);
  assert.strictEqual(r.pass, false);
  assert.match(r.detail, /switched off at test\/app\.test\.js:1/);
  assert.strictEqual(run('no-test-weakening', { ...t, prompt: 'skip the flaky test for now' }).pass, true);
  write(dir, 'test/app.test.js', "test('a', () => {});\n");
  assert.strictEqual(run('no-test-weakening', t).pass, true);
  fs.unlinkSync(path.join(dir, 'test/b.test.js'));
  assert.match(run('no-test-weakening', t).detail, /test file removed: test\/b\.test\.js/);
  write(dir, 'test/unit/b.test.js', 'b\n');
  assert.strictEqual(run('no-test-weakening', t).pass, true, 'a moved test file is not a removal');
});

test('conflict-or-debugger blocks an added conflict marker or debugger statement', () => {
  const dir = repo();
  const t = turn(dir, 'merge the two helpers');
  write(dir, 'notes.md', 'Title\n=======\nthe word debugger in prose\n');
  write(dir, 'app.js', 'const debuggerEnabled = false;\n');
  assert.strictEqual(run('conflict-or-debugger', t).pass, true);
  write(dir, 'app.js', 'function f() {\n  debugger;\n}\n');
  assert.match(run('conflict-or-debugger', t).detail, /debugger statement left at app\.js:2/);
  write(dir, 'app.js', '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n');
  assert.match(run('conflict-or-debugger', t).detail, /conflict marker left at app\.js:1/);
  write(dir, 'app.js', 'const label = "old text";\n');
  assert.strictEqual(run('conflict-or-debugger', t).pass, true);
});

test('outputLinesNaming matches a changed file by path, by a tail with a directory, and not by a longer name', () => {
  const out = ['src/ui/card.tsx(3,1): error TS1', 'ui/card.tsx:9:2 - error TS2', 'other/card.tsx(1,1): error TS3', 'mysrc/ui/card.tsxx: no', '/abs/repo/src/ui/card.tsx: error TS4', 'main.ts(1,1): error', 'xmain.ts(1,1): error'].join('\n');
  assert.deepStrictEqual(check.outputLinesNaming(out, ['src/ui/card.tsx']), ['src/ui/card.tsx(3,1): error TS1', 'ui/card.tsx:9:2 - error TS2', '/abs/repo/src/ui/card.tsx: error TS4']);
  assert.deepStrictEqual(check.outputLinesNaming(out, ['main.ts']), ['main.ts(1,1): error']);
  assert.deepStrictEqual(check.outputLinesNaming(out, []), []);
});

test('typecheck blocks only when the output names a file changed this turn', () => {
  const dir = repo();
  write(dir, '.claude/buc.json', JSON.stringify({ typecheckCmd: 'node tc.js' }));
  write(dir, 'tc.js', 'console.log("legacy/old.ts(4,2): error TS2304: Cannot find name"); process.exit(2)\n');
  const t = turn(dir, 'edit app');
  write(dir, 'app.js', 'changed\n');
  const ok = run('typecheck', t);
  assert.strictEqual(ok.pass, true);
  assert.match(ok.detail, /not in a file changed this turn/);
  write(dir, 'tc.js', 'console.log("legacy/old.ts(4,2): error TS1\\napp.js(1,1): error TS2322: bad type"); process.exit(2)\n');
  const r = run('typecheck', t);
  assert.strictEqual(r.pass, false);
  assert.match(r.detail, /node tc\.js exit 2: app\.js\(1,1\): error TS2322/);
  assert.doesNotMatch(r.detail, /legacy/);
});

test('ended-with-question fires on a short edit prompt answered by a question with no change', () => {
  const dir = repo();
  const t = turn(dir, 'make the header blue');
  const ask = { last_assistant_message: 'Which header do you mean, the page one or the card one?' };
  const r = run('ended-with-question', t, ask);
  assert.strictEqual(r.pass, false);
  assert.match(r.detail, /Pick the likeliest reading/);
  assert.strictEqual(run('ended-with-question', t, { last_assistant_message: 'Done. The header is blue.' }).pass, true);
  assert.strictEqual(run('ended-with-question', t, {}).pass, true, 'no reply text');
  assert.strictEqual(run('ended-with-question', { ...t, prompt: 'delete the old migrations' }, ask).pass, true, 'destructive word');
  assert.strictEqual(run('ended-with-question', { ...t, prompt: Array(26).fill('word').join(' ') }, ask).pass, true, 'long prompt');
  assert.strictEqual(run('ended-with-question', { ...t, kind: 'advice' }, ask).pass, true);
  assert.strictEqual(run('ended-with-question', { ...t, intent: 'HANDSOFF' }, ask).pass, true);
  write(dir, 'app.js', 'changed\n');
  assert.strictEqual(run('ended-with-question', t, ask).pass, true, 'something changed');
});

test('wide-diff fires on a literal turn over 5 files or 150 lines, and not on other intents', () => {
  const dir = repo({ 'app.js': `${Array(100).fill('old').join('\n')}\n` });
  for (const intent of ['LITERAL', 'EXACT']) assert.strictEqual(run('wide-diff', turn(dir, 'set the title to Home', { intent })).pass, true);
  const t = turn(dir, 'set the title to Home', { intent: 'LITERAL' });
  for (let i = 0; i < 5; i++) write(dir, `f${i}.js`, 'x\n');
  assert.strictEqual(run('wide-diff', t).pass, true, '5 files is within the limit');
  write(dir, 'f5.js', 'x\n');
  const r = run('wide-diff', t);
  assert.strictEqual(r.pass, false);
  assert.match(r.detail, /^6 files and 6 lines changed/);
  assert.strictEqual(run('wide-diff', { ...t, intent: 'FEATURE' }).pass, true);
  assert.strictEqual(run('wide-diff', { ...t, intent: undefined }).pass, true);
  for (let i = 0; i < 6; i++) fs.unlinkSync(path.join(dir, `f${i}.js`));
  write(dir, 'app.js', `${Array(100).fill('new').join('\n')}\n`);
  assert.match(run('wide-diff', t).detail, /^1 files and 200 lines changed/);
});

test('checkSession runs every built-in check on a turn with a baseline, marks soft ones, and each has a BUC_OFF name', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  const ids = ['undo-restored', 'handsoff-no-edits', 'sweep-residue', 'no-test-weakening', 'conflict-or-debugger', 'ended-with-question', 'wide-diff', 'sweep-scope', 'neighbour-states'];
  assert.deepStrictEqual(Object.keys(check.BUILTIN), ids);
  withEnv({ BUC_HOME: home, BUC_OFF: '' }, () => {
    store.writeTurn('s', turn(dir, 'make the header blue'));
    write(dir, 'app.js', 'function f() {\n  debugger;\n}\n');
    const res = check.checkSession('s', {});
    assert.deepStrictEqual(res.map((r) => r.id), ids);
    assert.deepStrictEqual(res.filter((r) => r.soft).map((r) => r.id), ['ended-with-question', 'wide-diff', 'sweep-scope', 'neighbour-states']);
    assert.deepStrictEqual(res.filter((r) => !r.pass).map((r) => r.id), ['conflict-or-debugger']);
    const { porcelain, ...noBase } = turn(dir, 'x');
    store.writeTurn('nobase', noBase);
    assert.deepStrictEqual(check.checkSession('nobase', {}), []);
  });
  for (const id of ids) {
    withEnv({ BUC_HOME: home, BUC_OFF: `x, ${id}` }, () => assert.ok(!check.checkSession('s', {}).some((r) => r.id === id), id));
  }
  write(dir, '.claude/buc.json', JSON.stringify({ off: ['conflict-or-debugger'] }));
  withEnv({ BUC_HOME: home, BUC_OFF: '' }, () => assert.ok(check.checkSession('s', {}).every((r) => r.pass)));
});

// Writes the turn file the prompt hook would, into `home`.
const seedTurn = (home, t) => { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, `turn-${t.session_id}.json`), JSON.stringify(t)); };

test('Stop: a hard check blocks, a soft check returns additionalContext and never a decision', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  seedTurn(home, turn(dir, 'make the header blue'));
  const soft = hook('stop-check.js', { session_id: 's', cwd: dir, last_assistant_message: 'Which header?' }, home);
  assert.deepStrictEqual(Object.keys(soft), ['hookSpecificOutput']);
  assert.strictEqual(soft.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(soft.hookSpecificOutput.additionalContext, /^You ended with a question/);
  assert.ok(fs.existsSync(path.join(home, 'turn-s.json')), 'turn kept for the continuation');
  write(dir, 'app.js', 'function f() {\n  debugger;\n}\n');
  const hard = hook('stop-check.js', { session_id: 's', cwd: dir, last_assistant_message: 'Done.' }, home);
  assert.strictEqual(hard.decision, 'block');
  assert.match(hard.reason, /^Fix before finishing: conflict-or-debugger: debugger statement left at app\.js:2/);
  assert.strictEqual(hard.hookSpecificOutput, undefined);
});

test('Stop: stop_hook_active suppresses every check, hard and soft', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  seedTurn(home, turn(dir, 'make the header blue', { intent: 'HANDSOFF' }));
  write(dir, 'app.js', '<<<<<<< HEAD\n');
  assert.strictEqual(hook('stop-check.js', { session_id: 's', cwd: dir }, home).decision, 'block');
  assert.strictEqual(hook('stop-check.js', { session_id: 's', cwd: dir, stop_hook_active: true, last_assistant_message: 'ok?' }, home), null);
  assert.ok(!fs.existsSync(path.join(home, 'turn-s.json')));
  seedTurn(home, turn(dir, 'make the footer blue'));
  assert.strictEqual(hook('stop-check.js', { session_id: 's', cwd: dir, stop_hook_active: true, last_assistant_message: 'Which one?' }, home), null);
});

test('Stop: a soft note rides along with a block, and BUC_OFF switches a check off in the hook', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  seedTurn(home, turn(dir, 'set the title to Home', { intent: 'LITERAL' }));
  for (let i = 0; i < 6; i++) write(dir, `f${i}.js`, 'x\n');
  write(dir, 'app.js', '  debugger\n');
  const out = hook('stop-check.js', { session_id: 's', cwd: dir }, home);
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /conflict-or-debugger.*remove it\. Also: 7 files and 8 lines changed/);
  assert.ok(out.reason.length <= 600);
  const soft = hook('stop-check.js', { session_id: 's', cwd: dir }, home, { BUC_OFF: 'conflict-or-debugger' });
  assert.strictEqual(soft.decision, undefined);
  assert.match(soft.hookSpecificOutput.additionalContext, /^7 files/);
  assert.strictEqual(hook('stop-check.js', { session_id: 's', cwd: dir }, home, { BUC_OFF: 'conflict-or-debugger,wide-diff' }), null);
});

test('Stop stores what the turn changed, and the next undo turn is held to it', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  withEnv({ BUC_HOME: home, BUC_OFF: '' }, () => store.saveLastTurn('s', { rules: ['r1'], repo: 'k', ts: 1 }));
  const first = turn(dir, 'make the label nicer');
  seedTurn(home, first);
  write(dir, 'app.js', 'const label = "nicer";\n');
  write(dir, 'made.js', 'new\n');
  assert.strictEqual(hook('stop-check.js', { session_id: 's', cwd: dir, last_assistant_message: 'Done.' }, home), null);
  const last = JSON.parse(fs.readFileSync(path.join(home, 'lastturn-s.json'), 'utf8'));
  assert.deepStrictEqual(last.rules, ['r1']);
  assert.strictEqual(last.head, first.head);
  assert.deepStrictEqual(last.files, { 'app.js': git(dir, 'rev-parse', 'HEAD:app.js'), 'made.js': null });
  seedTurn(home, turn(dir, 'undo that, just show me', { intent: 'UNDO', prevFiles: last.files }));
  const out = hook('stop-check.js', { session_id: 's', cwd: dir, last_assistant_message: 'Here is how.' }, home);
  assert.match(out.reason, /undo-restored: .*app\.js, made\.js/);
  git(dir, 'checkout', '--', 'app.js');
  fs.unlinkSync(path.join(dir, 'made.js'));
  seedTurn(home, turn(dir, 'undo that, just show me', { intent: 'UNDO', prevFiles: last.files }));
  assert.strictEqual(hook('stop-check.js', { session_id: 's', cwd: dir, last_assistant_message: 'Here is how.' }, home), null);
});

test('Stop does nothing without a session, a turn file or a baseline', () => {
  const home = tmp('buc-home-');
  assert.strictEqual(hook('stop-check.js', {}, home), null);
  assert.strictEqual(hook('stop-check.js', { session_id: 'none', last_assistant_message: 'what?' }, home), null);
  seedTurn(home, { session_id: 'bare', toolCalls: 3 });
  assert.strictEqual(hook('stop-check.js', { session_id: 'bare', last_assistant_message: 'what?' }, home), null);
});

const track = require('../hooks/track');
const batch = (n, extra = {}) => ({ session_id: 't', hook_event_name: 'PostToolBatch', tool_calls: Array.from({ length: n }, () => ({ tool_name: 'Read', tool_input: {} })), ...extra });

test('track counts tool calls per turn and fires exactly at the budget and at twice it', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  withEnv({ BUC_HOME: home, BUC_OFF: '' }, () => {
    store.writeTurn('t', turn(dir, 'set the title to Home', { session_id: 't', intent: 'LITERAL' }));
    const fired = [];
    for (let i = 1; i <= 45; i++) {
      const out = track.run(batch(1, { cwd: dir }));
      if (out) fired.push([i, out.hookSpecificOutput.additionalContext]);
    }
    assert.deepStrictEqual(fired.map((f) => f[0]), [20, 40]);
    assert.strictEqual(fired[0][1], 'Budget: 20 tool calls on a small request. Stop exploring, finish the edit you have, report what is unverified.');
    assert.strictEqual(store.readTurn('t').toolCalls, 45);
    assert.strictEqual(store.readTurn('t').intent, 'LITERAL', 'other turn fields are kept');
    // A new prompt writes a fresh turn file: the count starts again.
    store.writeTurn('t', turn(dir, 'add a settings page', { session_id: 't', intent: 'SELF' }));
    assert.strictEqual(track.run(batch(44, { cwd: dir })), null);
    assert.strictEqual(store.readTurn('t').toolCalls, 44);
    const out = track.run(batch(3, { cwd: dir }));
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolBatch');
    assert.match(out.hookSpecificOutput.additionalContext, /^Budget: 47 tool calls on one request\./);
    assert.strictEqual(track.run(batch(1, { cwd: dir })), null, 'only once per threshold');
  });
});

test('track: a batch that jumps the threshold fires once, a missing intent uses the large budget, config and BUC_OFF apply', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  withEnv({ BUC_HOME: home, BUC_OFF: '' }, () => {
    store.writeTurn('t', turn(dir, 'fix it', { session_id: 't', intent: 'MISREAD' }));
    assert.strictEqual(track.run(batch(19, { cwd: dir })), null);
    assert.match(track.run(batch(5, { cwd: dir })).hookSpecificOutput.additionalContext, /^Budget: 24 tool calls/);
    assert.strictEqual(track.budget({}, dir), 45);
    assert.strictEqual(track.budget({ intent: 'SELF' }, dir), 45);
    assert.strictEqual(track.budget({ intent: 'UNDO' }, dir), 20);
    write(dir, '.claude/buc.json', JSON.stringify({ toolBudget: { small: 3 } }));
    assert.strictEqual(track.budget({ intent: 'UNDO' }, dir), 3);
    assert.strictEqual(track.budget({ intent: 'SELF' }, dir), 45);
    write(dir, '.claude/buc.json', JSON.stringify({ toolBudget: 7 }));
    assert.strictEqual(track.budget({ intent: 'SELF' }, dir), 7);
    write(dir, '.claude/buc.json', JSON.stringify({ toolBudget: false }));
    assert.strictEqual(track.budget({ intent: 'UNDO' }, dir), 0);
    fs.unlinkSync(path.join(dir, '.claude/buc.json'));
  });
  withEnv({ BUC_HOME: home, BUC_OFF: 'budget' }, () => {
    store.writeTurn('t', turn(dir, 'fix it', { session_id: 't', intent: 'MISREAD' }));
    assert.strictEqual(track.run(batch(25, { cwd: dir })), null);
    assert.strictEqual(store.readTurn('t').toolCalls, 25, 'still counted when the notice is off');
  });
});

test('track works with no turn file, a PostToolUse input and a subagent, and notes a buc-shot call', () => {
  const home = tmp('buc-home-');
  withEnv({ BUC_HOME: home, BUC_OFF: '', BUC_NOW: '1700000000000' }, () => {
    assert.strictEqual(track.run({}), null);
    assert.strictEqual(track.run({ session_id: 'n', tool_calls: [] }), null);
    assert.strictEqual(track.run({ session_id: 'n', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {} }), null);
    assert.deepStrictEqual(store.readTurn('n'), { session_id: 'n', toolCalls: 1, lastEditAt: 1 });
    assert.strictEqual(track.run({ ...batch(30), session_id: 'n', agent_id: 'agent-1' }), null);
    assert.strictEqual(store.readTurn('n').toolCalls, 1, 'subagent calls are not counted');
    track.run({ session_id: 'n', tool_calls: [{ tool_name: 'Bash', tool_input: { command: 'node /p/bin/buc-shot --path /' } }] });
    assert.strictEqual(store.readTurn('n').shotAt, 1700000000000);
  });
});

test('track runs under 60 ms per call and the hook script prints valid JSON', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  withEnv({ BUC_HOME: home, BUC_OFF: '' }, () => {
    store.writeTurn('t', turn(dir, 'set the title', { session_id: 't', intent: 'LITERAL' }));
    track.run(batch(1, { cwd: dir }));
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 10; i++) track.run(batch(1, { cwd: dir }));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 10;
    assert.ok(ms < 60, `${ms} ms per call`);
  });
  const out = hook('track.js', batch(9, { cwd: dir }), home);
  assert.match(out.hookSpecificOutput.additionalContext, /^Budget: 20 tool calls/);
  assert.strictEqual(hook('track.js', batch(1, { cwd: dir }), home), null);
});

// A repo holding the UI fixture app, with a dev server in .claude/buc.json, and a stand-in browser for the hook to use.
function uiRepo(conf = { ui: { dev: 'node server.js' } }) {
  const fx = path.join(__dirname, 'fixtures', 'ui-app');
  const dir = repo({ 'server.js': fs.readFileSync(path.join(fx, 'server.js'), 'utf8'), 'index.html': fs.readFileSync(path.join(fx, 'index.html'), 'utf8'), 'app.js': 'a\n', '.claude/buc.json': JSON.stringify(conf) });
  const bin = path.join(tmp('buc-bin-'), 'fake-chrome');
  // For --dump-dom it prints the page the tests write, so the changed classes count as shown.
  fs.writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) printf PNGDATA > "${a#--screenshot=}";; --dump-dom) echo \'<div class="card wide">hi</div>\';; esac; done\n', { mode: 0o755 });
  return { dir, env: { BUC_SHOT_ENGINE: 'chrome', BUC_CHROME: bin, BUC_PLAYWRIGHT: '' } };
}

test('Stop fallback: UI files changed and no shot gives the PNG path as additionalContext, once', () => {
  const { dir, env } = uiRepo();
  const home = tmp('buc-home-');
  seedTurn(home, turn(dir, 'make the card wider'));
  write(dir, 'index.html', '<div class="card wide">hi</div>\n');
  const out = hook('stop-check.js', { session_id: 's', cwd: dir, last_assistant_message: 'Done.' }, home, env);
  assert.strictEqual(out.decision, undefined);
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /^You changed UI files and took no screenshot\. Here is http:\/\/localhost:\d+\/ after your change, showing \.card, \.wide: (\S+\.png) \. Read it once/);
  const png = text.match(/: (\S+\.png) /)[1];
  assert.strictEqual(fs.readFileSync(png, 'utf8'), 'PNGDATA');
  fs.rmSync(png);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'turn-s.json'), 'utf8'));
  assert.ok(saved.shotAt > 0, 'the shot is recorded in the turn file');
  assert.strictEqual(hook('stop-check.js', { session_id: 's', cwd: dir, last_assistant_message: 'Done.' }, home, env), null, 'not again in the same turn');
});

test('Stop fallback stays quiet: shot already taken, no UI file, ui off, BUC_OFF=shot, no engine, or a hard block', () => {
  const { dir, env } = uiRepo();
  const home = tmp('buc-home-');
  const stop = (extraEnv = {}) => hook('stop-check.js', { session_id: 's', cwd: dir, last_assistant_message: 'Done.' }, home, { ...env, ...extraEnv });
  seedTurn(home, turn(dir, 'rename a variable'));
  write(dir, 'app.js', 'b\n');
  assert.strictEqual(stop(), null, 'no UI file changed');
  seedTurn(home, turn(dir, 'make the card wider', { shotAt: 123 }));
  write(dir, 'index.html', '<div class="card wide">hi</div>\n');
  assert.strictEqual(stop(), null, 'the agent already took one');
  seedTurn(home, turn(dir, 'make the card wider'));
  assert.strictEqual(stop({ BUC_OFF: 'shot' }), null);
  seedTurn(home, turn(dir, 'make the card wider'));
  assert.strictEqual(stop({ BUC_SHOT_ENGINE: 'none' }), null, 'skipped is silent');
  const hard = uiRepo();
  seedTurn(home, turn(hard.dir, 'make the card wider'));
  write(hard.dir, 'index.html', '<<<<<<< HEAD\n<div class="card wide">hi</div>\n');
  const blocked = hook('stop-check.js', { session_id: 's', cwd: hard.dir }, home, hard.env);
  assert.strictEqual(blocked.decision, 'block');
  assert.doesNotMatch(blocked.reason, /screenshot/);
  const off = uiRepo({ ui: false });
  seedTurn(home, turn(off.dir, 'make the card wider'));
  write(off.dir, 'index.html', '<div class="card wide">hi</div>\n');
  assert.strictEqual(hook('stop-check.js', { session_id: 's', cwd: off.dir }, home, off.env), null);
});

// end
