'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classify } = require('../lib/classify');

const table = [
  ['review the auth module', 'review'],
  ['explain how the router works', 'review'],
  ['audit src/api.js', 'review'],
  ['check the deploy script for mistakes', 'review'],
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
  ['audit how we set cookies in server.js', 'review'],
  ['review the build script and tell me what is wrong', 'review'],
  ['inspect how passwords are stored and explain it', 'review'],
  ['review server.js and fix the cookie flags', 'small'],
  ['Add a way to mark todos as done and show it in the list.', 'small'],
  ['add a stats line to the summary output', 'small'],
  ['edit a.js and b.js to share the helper', 'planned'],
  ['Fix greet.js so greet(name) returns "Hello, <name>!" (for example greet("Ana") returns "Hello, Ana!"). Acceptance: node test.js prints ok', 'small'],
  ['Rename function fooA in src/a.js to alpha and fooB in src/b.js to beta, update callers in index.js. Acceptance: node index.js prints alpha beta', 'small'],
  ['Add a STRIPE key setting to config.js read from process.env.STRIPE_KEY, and a note in README. Do not commit secrets.', 'small'],
  ['Users report the save button says Saved even when saving fails. Fix it so failures show an error. Acceptance: node test.js', 'small'],
  ['Look at main and tell me the current version in VERSION; write it into answer.txt.', 'small'],
  ['Add a retry to fetch.js. Do not commit secrets or tokens.', 'small'],
  ['Look at main and tell me what changed in the auth module.', 'review'],
  ['what does token refresh do in auth.js', 'review'],
  ['how does login work?', 'review'],
  ['explain the payment webhook flow', 'review'],
  ['where is the session token stored', 'review'],
  ['Look at main and write VERSION into answer.txt.', 'small'],
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
