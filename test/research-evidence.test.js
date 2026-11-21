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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/rules/store');

function withHome(fn, env = {}) {
  const keys = ['BUC_HOME', 'BUC_OFF', ...Object.keys(env)];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { BUC_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'buc-ev-')), BUC_OFF: '', ...env });
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('stopChecks reads the turn file, reports one gap once and honours BUC_OFF', () => {
  withHome(() => {
    assert.deepStrictEqual(evidence.stopChecks('none', say('All tests pass.')), []);
    store.patchTurn('e', { kind: 'edit', prompt: 'fix the crash', toolCalls: 2, lastEditAt: 2 });
    const both = evidence.stopChecks('e', say('Fixed. All tests pass.'));
    assert.deepStrictEqual(both.map((r) => [r.id, r.pass]), [['unbacked-claim', false]]);
    assert.deepStrictEqual(evidence.stopChecks('e', say('Fixed.')).map((r) => [r.id, r.pass]), [['unbacked-claim', true], ['edit-unrun', false]]);
    process.env.BUC_OFF = 'unbacked-claim,edit-unrun';
    assert.deepStrictEqual(evidence.stopChecks('e', say('Fixed. All tests pass.')), []);
  });
});

test('Stop hook: an unbacked claim blocks once, never when stop_hook_active, and a soft gap is feedback', () => {
  const stop = require('../hooks/stop-check');
  withHome(() => {
    store.patchTurn('h', { kind: 'edit', prompt: 'fix the crash', toolCalls: 2, lastEditAt: 2 });
    const out = stop.run({ session_id: 'h', last_assistant_message: 'Fixed. All tests pass.' });
    assert.strictEqual(out.decision, 'block');
    assert.match(out.reason, /unbacked-claim: Your reply says tests pass/);
    assert.strictEqual(stop.run({ session_id: 'h', stop_hook_active: true, last_assistant_message: 'Fixed. All tests pass.' }), null);
    assert.strictEqual(store.readTurn('h'), null, 'the second stop clears the turn');
    store.patchTurn('h2', { kind: 'edit', prompt: 'fix the crash', toolCalls: 2, lastEditAt: 2 });
    const soft = stop.run({ session_id: 'h2', last_assistant_message: 'Fixed.' });
    assert.strictEqual(soft.decision, undefined);
    assert.match(soft.hookSpecificOutput.additionalContext, /ran nothing after your last edit/);
    store.patchTurn('h3', { kind: 'edit', prompt: 'rename the helper', toolCalls: 4, lastEditAt: 2, lastRunAt: 4, lastTestAt: 4, lastTestOk: true });
    assert.strictEqual(stop.run({ session_id: 'h3', last_assistant_message: 'Renamed. All tests pass.' }), null);
  });
});
