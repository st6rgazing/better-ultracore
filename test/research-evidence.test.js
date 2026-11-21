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

const say = (text) => ({ last_assistant_message: text });

test('unbacked-claim blocks a tests-pass claim with no run after an edit or a failed last run', () => {
  const r = evidence.unbacked({ toolCalls: 3, lastEditAt: 3 }, say('Fixed it. All tests pass.'));
  assert.deepStrictEqual([r.id, r.pass, r.soft], ['unbacked-claim', false, false]);
  assert.match(r.detail, /no test command ran/);
  const failed = evidence.unbacked({ toolCalls: 5, lastEditAt: 2, lastRunAt: 4, lastTestAt: 4, lastTestOk: false }, say('All tests pass.'));
  assert.match(failed.detail, /last test run this turn failed/);
  assert.strictEqual(evidence.unbacked({ toolCalls: 4, lastEditAt: 4 }, say('I verified the page loads.')).pass, false);
});

test('unbacked-claim passes with a run, with no edit, with no log, with no claim, and is soft after a subagent', () => {
  const ok = [
    [{ toolCalls: 5, lastEditAt: 2, lastRunAt: 4, lastTestAt: 4, lastTestOk: true }, 'All tests pass.'],
    [{ toolCalls: 5, lastEditAt: 2, lastRunAt: 4 }, 'All tests pass.'],
    [{ toolCalls: 2 }, 'The tests pass, as before.'],
    [{}, 'All tests pass.'],
    [{ toolCalls: 3, lastEditAt: 3 }, 'Changed the label. I did not run the tests.'],
    [{ toolCalls: 5, lastEditAt: 3 }, 'I verified the file reads back as expected.'],
    [{ toolCalls: 6, lastEditAt: 6, lastTestAt: 5, lastTestOk: true }, 'All tests pass.'],
  ];
  for (const [turn, reply] of ok) assert.strictEqual(evidence.unbacked(turn, say(reply)).pass, true, reply);
  const soft = evidence.unbacked({ toolCalls: 3, lastEditAt: 2, agents: 1 }, say('All tests pass.'));
  assert.deepStrictEqual([soft.pass, soft.soft], [false, true]);
});

test('edit-unrun is soft and fires only on a bug-fix edit with no run after the last edit', () => {
  const turn = (extra) => ({ kind: 'edit', prompt: 'fix the crash when the list is empty', toolCalls: 3, lastEditAt: 3, ...extra });
  const r = evidence.unrun(turn(), say('Fixed the crash.'));
  assert.deepStrictEqual([r.id, r.pass, r.soft], ['edit-unrun', false, true]);
  assert.strictEqual(evidence.unrun(turn({ lastRunAt: 4 }), say('Fixed.')).pass, true, 'ran after the edit');
  assert.strictEqual(evidence.unrun(turn({ lastRunAt: 2 }), say('Fixed.')).pass, false, 'ran only before the edit');
  assert.strictEqual(evidence.unrun(turn(), say('Fixed, but unverified: I did not run it.')).pass, true);
  assert.strictEqual(evidence.unrun(turn({ prompt: 'fix the typo in the README' }), say('Fixed.')).pass, true);
  assert.strictEqual(evidence.unrun(turn({ prompt: 'add a dark mode toggle' }), say('Added.')).pass, true);
  assert.strictEqual(evidence.unrun(turn({ kind: 'advice' }), say('It crashes because of x.')).pass, true);
  assert.strictEqual(evidence.unrun(turn({ lastEditAt: undefined }), say('It crashes because of x.')).pass, true);
  assert.strictEqual(evidence.unrun(turn({ intent: 'UNDO' }), say('Restored.')).pass, true);
});
