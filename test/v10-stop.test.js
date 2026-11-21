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
