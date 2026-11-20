'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sumTokens } = require('../bench/run');

const CASES = path.join(__dirname, '..', 'bench', 'cases');
const run = (c, script, dir) => spawnSync('sh', [path.join(CASES, c, script), dir]).status;

for (const c of fs.readdirSync(CASES).filter((n) => fs.existsSync(path.join(CASES, n, 'setup.sh'))).sort()) {
  test(`bench case ${c}: accept fails unsolved, passes solved`, () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), `benchtest-${c}-`));
    const dir = path.join(parent, 'work');
    try {
      assert.strictEqual(run(c, 'setup.sh', dir), 0);
      assert.notStrictEqual(run(c, 'accept.sh', dir), 0);
      assert.strictEqual(run(c, 'solve.sh', dir), 0);
      assert.strictEqual(run(c, 'accept.sh', dir), 0);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });
}

test('sumTokens sums input incl. cache across models', () => {
  const mu = { a: { inputTokens: 1, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, outputTokens: 4 }, b: { inputTokens: 10, outputTokens: 5 } };
  assert.deepStrictEqual(sumTokens(mu, null), { input: 16, output: 9 });
});
