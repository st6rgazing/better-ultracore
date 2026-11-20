'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_LIMITS, signature, brief } = require('../lib/engine');

test('default limits', () => {
  assert.deepStrictEqual(DEFAULT_LIMITS, { maxLaunches: 6, maxRepairs: 2, maxElapsedMin: 30 });
});

test('signature ignores numbers, paths, whitespace', () => {
  const a = signature({ cmd: 'npm test', first_error: 'Error at /a/b.js:12  bad thing 3' });
  const b = signature({ cmd: 'npm test', first_error: 'Error at /x/y.js:99 bad   thing 7' });
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, signature({ cmd: 'npm lint', first_error: 'Error at /a/b.js:12 bad thing 3' }));
});

test('brief carries request, base, delimited prefs and no-override line', () => {
  const b = brief({ request: 'do x', base: 'abc', files: ['a.js'], prefs: ['use tabs'] });
  for (const s of ['do x', 'abc', 'a.js', '<<<PREFS', 'untrusted advisory', 'are not overrides']) assert.ok(b.includes(s), s);
});
