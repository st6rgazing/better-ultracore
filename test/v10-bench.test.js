'use strict';
const test = require('node:test');
const assert = require('node:assert');
const stats = require('../bench/stats');

test('rng is deterministic per seed and stays in [0,1)', () => {
  const a = stats.rng(10);
  const b = stats.rng(10);
  const c = stats.rng(11);
  const xs = Array.from({ length: 50 }, () => a());
  assert.deepStrictEqual(xs, Array.from({ length: 50 }, () => b()));
  assert.notStrictEqual(xs[0], c());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('value reads keys, functions and booleans', () => {
  assert.strictEqual(stats.value({ interventions: 2 }, 'interventions'), 2);
  assert.strictEqual(stats.value({ first_try_pass: true }, 'first_try_pass'), 1);
  assert.strictEqual(stats.value({ a: 1 }, (r) => r.a + 1), 2);
  assert.strictEqual(stats.value({}, 'missing'), null);
});

const ROWS = [
  { case: 'x', arm: 'buc', interventions: 0 }, { case: 'x', arm: 'buc', interventions: 1 },
  { case: 'x', arm: 'plain', interventions: 2 }, { case: 'x', arm: 'plain', interventions: 2 },
  { case: 'y', arm: 'buc', interventions: 1 }, { case: 'y', arm: 'plain', interventions: 1 },
  { case: 'z', arm: 'buc', interventions: 0 },
  { case: 'y', arm: 'ultra', interventions: 9 },
];

test('caseDiffs pairs arms within a case and drops unpaired cases', () => {
  assert.deepStrictEqual(stats.caseDiffs(ROWS, 'buc', 'plain', 'interventions'), [{ case: 'x', diff: -1.5 }, { case: 'y', diff: 0 }]);
});
