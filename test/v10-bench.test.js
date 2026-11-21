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

test('quantile interpolates', () => {
  assert.strictEqual(stats.quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.strictEqual(stats.quantile([0, 10], 0.25), 2.5);
  assert.strictEqual(stats.quantile([], 0.5), null);
});

test('pairedBootstrap: mean difference, reproducible interval, clustered by case', () => {
  const a = stats.pairedBootstrap(ROWS, 'buc', 'plain', 'interventions', { B: 2000, seed: 10 });
  assert.strictEqual(a.diff, -0.75);
  assert.strictEqual(a.cases, 2);
  assert.ok(a.lo <= a.diff && a.diff <= a.hi);
  assert.ok(a.lo >= -1.5 && a.hi <= 0);
  assert.deepStrictEqual(a, stats.pairedBootstrap(ROWS, 'buc', 'plain', 'interventions', { B: 2000, seed: 10 }));
  // Ten more reps of the same two cases must not narrow the interval: the unit is the case.
  const many = [];
  for (let i = 0; i < 10; i++) many.push(...ROWS);
  const b = stats.pairedBootstrap(many, 'buc', 'plain', 'interventions', { B: 2000, seed: 10 });
  assert.strictEqual(b.lo, a.lo);
  assert.strictEqual(b.hi, a.hi);
});

test('pairedBootstrap: a consistent effect excludes zero, no pairs gives nulls', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ case: `c${i}`, arm: 'buc', interventions: i % 3 === 0 ? 1 : 0 }, { case: `c${i}`, arm: 'plain', interventions: 1 + (i % 2) });
  const r = stats.pairedBootstrap(rows, 'buc', 'plain', 'interventions', { B: 3000 });
  assert.ok(r.hi < 0);
  assert.strictEqual(stats.pairedBootstrap([], 'buc', 'plain', 'interventions').diff, null);
});

test('stats CLI prints one JSON line', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
  try {
    fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify(ROWS));
    const p = spawnSync('node', [path.join(__dirname, '..', 'bench', 'stats.js'), path.join(dir, 'r.json'), '--B', '500'], { encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stderr);
    const o = JSON.parse(p.stdout);
    assert.strictEqual(o.diff, -0.75);
    assert.strictEqual(o.metric, 'interventions');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
