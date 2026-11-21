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

module.exports = { repo, turn, run, write, tmp, git, hook, withEnv };
