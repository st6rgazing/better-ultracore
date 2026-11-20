'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { retrieve } = require('../lib/rules/retrieve');

const BENCH = path.join(__dirname, '..', 'bench');
const rules = JSON.parse(fs.readFileSync(path.join(BENCH, 'fixtures', 'rules.json'), 'utf8'));
const cases = fs.readdirSync(path.join(BENCH, 'cases')).filter((c) => fs.existsSync(path.join(BENCH, 'cases', c, 'expect-rules.json')));

test('every public bench case has an expect-rules.json', () => {
  const all = fs.readdirSync(path.join(BENCH, 'cases')).filter((c) => fs.existsSync(path.join(BENCH, 'cases', c, 'prompt.txt')));
  assert.deepStrictEqual(cases.sort(), all.sort());
});

test('rule retrieval over bench cases: precision >= 0.9, recall 1.0', () => {
  let tp = 0, fp = 0, fn = 0;
  for (const c of cases) {
    const dir = path.join(BENCH, 'cases', c);
    const prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
    const want = new Set(JSON.parse(fs.readFileSync(path.join(dir, 'expect-rules.json'), 'utf8')));
    const got = new Set(retrieve({ prompt, rules }).matched.map((r) => r.id));
    for (const id of got) want.has(id) ? tp++ : fp++;
    for (const id of want) if (!got.has(id)) fn++;
  }
  assert.strictEqual(fn, 0, 'recall must be 1.0');
  assert.ok(tp / (tp + fp) >= 0.9, `precision ${tp}/${tp + fp}`);
});

test('an unpinned rule needs a keyword/path hit and a compatible prompt kind', () => {
  const mk = (when, pinned = false) => ({ id: 'r', rule: 'x', when: { keywords: [], paths: [], promptKinds: [], ...when }, check: {}, count: 1, last_seen: new Date().toISOString(), pinned });
  assert.strictEqual(retrieve({ prompt: 'fix the thing', rules: [mk({ keywords: ['thing'], promptKinds: ['advice'] })] }).matched.length, 0);
  assert.strictEqual(retrieve({ prompt: 'fix the thing', rules: [mk({ promptKinds: ['edit'] })] }).matched.length, 0);
  assert.strictEqual(retrieve({ prompt: 'fix the thing', rules: [mk({ keywords: ['thing'], promptKinds: ['edit'] })] }).matched.length, 1);
  assert.strictEqual(retrieve({ prompt: 'fix the thing', rules: [mk({ keywords: ['thing'] })] }).matched.length, 1);
});

test('output order is stable by score then id', () => {
  const mk = (id) => ({ id, rule: 'x', when: { keywords: ['go'], paths: [], promptKinds: [] }, check: {}, count: 3, last_seen: '2026-11-01T00:00:00.000Z', pinned: false });
  const now = Date.parse('2026-11-02T00:00:00Z');
  const ids = retrieve({ prompt: 'go', rules: [mk('c'), mk('a'), mk('b')], now }).matched.map((r) => r.id);
  assert.deepStrictEqual(ids, ['a', 'b', 'c']);
});
