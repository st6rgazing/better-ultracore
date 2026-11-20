'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classify } = require('../lib/classify');

const table = [
  ['review the auth module', 'review'],
  ['explain how the router works', 'review'],
  ['audit src/api.js', 'review'],
  ['check the deploy script for mistakes', 'review'],
  ['fix the password reset flow', 'guarded'],
  ['add a payment retry', 'guarded'],
  ['write a migration for the users table', 'guarded'],
  ['delete old tokens from cache.js', 'guarded'],
  ['update permissions handling in roles.ts', 'guarded'],
  ['rename foo to bar in lib/util.js', 'small'],
  ['fix typo in README.md heading', 'small'],
  ['add a --json flag; it must print valid JSON. Run node --test', 'small'],
  ['change the default port\n- should be 8080\n- tests pass', 'small'],
  ['add a feature for exporting reports', 'planned'],
  ['improve the dashboard somehow', 'planned'],
  ['make the search something like Spotlight', 'planned'],
  ['Update the layout. Then wire it up. Then tidy the styles.', 'planned'],
  ['add dark mode and also add a CSV export', 'parallel'],
  ['1. fix a.js bug\n2. add b.py helper', 'parallel'],
  ['do the two things independently', 'parallel'],
];

for (const [req, route] of table) {
  test(`${route}: ${req.slice(0, 40).replace(/\n/g, ' ')}`, () => {
    assert.strictEqual(classify(req).route, route);
  });
}

test('uncertain when no signal fires', () => {
  const r = classify('hello there');
  assert.strictEqual(r.confidence, 'uncertain');
});

test('uncertain when signals conflict', () => {
  const r = classify('improve lib/a.js; it should return an array');
  assert.strictEqual(r.confidence, 'uncertain');
});

test('hasCriteria reported', () => {
  assert.strictEqual(classify('it must work').hasCriteria, true);
  assert.strictEqual(classify('hello').hasCriteria, false);
});

test('files option counts as named files', () => {
  assert.strictEqual(classify('1. do x\n2. do y', { files: ['a.js', 'b.js'] }).route, 'parallel');
});
