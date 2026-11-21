'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const check = require('../lib/rules/check');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'buc-v13-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  write(dir, 'src/sound.tsx', 'export const play = () => 1;\n');
  write(dir, 'src/MainMenu.tsx', "import { play } from './sound';\n");
  write(dir, 'src/Settings.tsx', "import { play } from './sound';\n");
  write(dir, 'src/util.js', 'module.exports = 1;\n');
  write(dir, 'src/uses-util.js', "require('./util');\n");
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const turn = (dir) => ({
  session_id: 's', cwd: dir, root: dir, prompt: 'fix the sound', kind: 'edit', head: git(dir, 'rev-parse', 'HEAD'),
  porcelain: execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), rules: [], checks: [],
});
const run = (t, reply) => check.runChecks(['neighbour-states'], t, t.root, { last_assistant_message: reply })[0];

test('neighbour-states is a soft built-in check', () => {
  assert.ok(check.BUILTIN['neighbour-states']);
  assert.ok(check.SOFT.includes('neighbour-states'));
});

test('names importers of a changed UI file the reply did not mention', () => {
  const dir = repo();
  const t = turn(dir);
  write(dir, 'src/sound.tsx', 'export const play = () => 2;\n');
  const r = run(t, 'Fixed the sound.');
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.detail, 'Other entry points use what you changed: src/MainMenu.tsx, src/Settings.tsx. Check each one (new vs continued state, every menu) and say what you verified.');
});

test('lists only the importers the reply left out, and passes when all are named', () => {
  const dir = repo();
  const t = turn(dir);
  write(dir, 'src/sound.tsx', 'export const play = () => 2;\n');
  const some = run(t, 'Fixed; checked MainMenu.');
  assert.strictEqual(some.pass, false);
  assert.ok(!some.detail.includes('MainMenu') && some.detail.includes('src/Settings.tsx'));
  assert.strictEqual(run(t, 'Verified in MainMenu and Settings.').pass, true);
});

test('passes for a non-UI change, no change, and a file nobody imports', () => {
  const dir = repo();
  const t = turn(dir);
  assert.strictEqual(run(t, 'done').pass, true);
  write(dir, 'src/util.js', 'module.exports = 2;\n');
  assert.strictEqual(run(t, 'done').pass, true);
  write(dir, 'src/Settings.tsx', "import { play } from './sound';\n// x\n");
  assert.strictEqual(run(t, 'done').pass, true);
});

test('caps the list at 8 files', () => {
  const dir = repo();
  for (let i = 0; i < 12; i++) write(dir, `src/m${i}.js`, "import './sound';\n");
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'more');
  const t = turn(dir);
  write(dir, 'src/sound.tsx', 'export const play = () => 2;\n');
  assert.strictEqual(run(t, 'done').detail.split(': ')[1].split('. Check')[0].split(', ').length, 8);
});

test('BUC_OFF=neighbours switches it off', () => {
  const dir = repo();
  const t = turn(dir);
  write(dir, 'src/sound.tsx', 'export const play = () => 2;\n');
  const old = process.env.BUC_OFF;
  process.env.BUC_OFF = 'neighbours';
  try { assert.strictEqual(run(t, 'done').pass, true); } finally { if (old === undefined) delete process.env.BUC_OFF; else process.env.BUC_OFF = old; }
});
