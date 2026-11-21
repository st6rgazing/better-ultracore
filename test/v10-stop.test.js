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
  const ids = ['undo-restored', 'handsoff-no-edits', 'sweep-residue', 'no-test-weakening', 'conflict-or-debugger', 'ended-with-question', 'wide-diff'];
  assert.deepStrictEqual(Object.keys(check.BUILTIN), ids);
  withEnv({ BUC_HOME: home, BUC_OFF: '' }, () => {
    store.writeTurn('s', turn(dir, 'make the header blue'));
    write(dir, 'app.js', 'function f() {\n  debugger;\n}\n');
    const res = check.checkSession('s', {});
    assert.deepStrictEqual(res.map((r) => r.id), ids);
    assert.deepStrictEqual(res.filter((r) => r.soft).map((r) => r.id), ['ended-with-question', 'wide-diff']);
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

// end
