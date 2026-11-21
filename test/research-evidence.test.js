'use strict';
const test = require('node:test');
const assert = require('node:assert');
const evidence = require('../lib/rules/evidence');

test('claims finds stated test and verification results and skips plans, doubts, questions and code', () => {
  const yes = ['All tests pass.', 'Done. The tests are passing now.', 'Fixed the parser; tests pass (42/42).', 'All 12 tests pass', 'The test suite is green.', 'npm test: 40 of 40 pass'];
  for (const r of yes) assert.strictEqual(evidence.claims(r).tests, true, r);
  const no = ['Run npm test to make sure the tests pass.', 'The tests should pass now.', 'I did not run the tests.', 'Tests were not run, so this is unverified.', 'Do the tests pass on your machine?', 'Once the tests pass, merge it.', 'Here is the output:\n```\nall tests pass\n```', 'I added a test for the empty case.', 'I couldn\'t confirm the tests pass.'];
  for (const r of no) assert.strictEqual(evidence.claims(r).tests, false, r);
  for (const r of ['I verified the page loads.', 'Verified: the header is blue.', 'I have tested the login flow by hand.', 'We confirmed the fix.']) assert.strictEqual(evidence.claims(r).verified, true, r);
  for (const r of ['Not verified.', 'This is unverified.', 'You can verify it with curl.', 'I have not tested this.', 'To verify, open the page.']) assert.strictEqual(evidence.claims(r).verified, false, r);
  assert.deepStrictEqual(evidence.claims(''), { tests: false, verified: false });
});
