'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'lib/preflight/cli.js');
const FAKE_AWS = 'AKIA' + 'FAKEFAKEFAKEFAKE';
const FAKE_GH = 'ghp' + '_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'buc-pf-'));

function buc(cwd, args) {
  const code = `require(${JSON.stringify(CLI)}).run(JSON.parse(process.env.BUC_ARGS)).then(c => process.exit(c))`;
  return spawnSync('node', ['-e', code], { cwd, encoding: 'utf8', env: { ...process.env, BUC_ARGS: JSON.stringify(args) } });
}

function readOut(cwd) {
  const dir = path.join(cwd, '.buc/preflight');
  return ['preflight.json', 'preflight.md'].map(f => fs.readFileSync(path.join(dir, f), 'utf8'));
}

const checkOf = (cwd, id) => JSON.parse(readOut(cwd)[0]).checks.find(c => c.id === id);

const SKIP = ['--skip-build', '--skip-browser'];

test('leak repo fails secrets check without printing values', () => {
  const d = tmp();
  execFileSync(path.join(ROOT, 'fixtures/repos/make-leak-repo.sh'), [d]);
  const r = buc(d, [...SKIP, '--base', 'HEAD~1']);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(checkOf(d, 'secrets').status, 'failed');
  const everything = [r.stdout, r.stderr, ...readOut(d)].join('\n');
  assert.ok(!everything.includes(FAKE_AWS));
  assert.ok(!everything.includes(FAKE_GH));
  assert.ok(!everything.includes('FAKEFAKE'));
});
