'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/rules/store');
const feedback = require('../lib/rules/feedback');

const rule = { id: 'a-rule', rule: 'R.', when: { keywords: ['x'] }, check: {}, kind: 'process', count: 4, last_seen: new Date().toISOString(), violations: 0, pinned: false };

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-fb-'));
  process.env.BUC_HOME = home;
  store.saveRules([{ ...rule }]);
  store.saveLastTurn('s1', { rules: ['a-rule'], repo: 'r1' });
  return home;
}
const stats = () => store.loadRules()[0].byRepo;

test('a correction demotes the previous rules for that repo and lands redacted in the inbox', () => {
  setup();
  const secret = 'sk-abcdefgh12345678';
  const out = feedback.onPrompt({ prompt: `no, that's wrong, token=${secret} ${'x'.repeat(400)}`, sessionId: 's1', repo: 'r1' });
  assert.strictEqual(out.correction, true);
  assert.deepStrictEqual(stats().r1, { hits: 0, misses: 1 });
  const inbox = store.readInbox();
  assert.strictEqual(inbox.length, 1);
  assert.ok(inbox[0].prompt.length <= 240);
  assert.deepStrictEqual(inbox[0].prevRules, ['a-rule']);
  assert.strictEqual(inbox[0].repo, 'r1');
  assert.ok(!JSON.stringify(inbox).includes(secret));
  const r = store.loadRules()[0];
  assert.ok(store.score(r, Date.now(), 'r1') < store.score(r, Date.now(), 'other'));
});

test('"i said" anywhere counts as a correction', () => {
  setup();
  assert.strictEqual(feedback.onPrompt({ prompt: 'please, as I said before, keep it short', sessionId: 's1', repo: 'r1' }).correction, true);
});

test('a normal follow-up promotes and saves nothing to the inbox', () => {
  setup();
  const out = feedback.onPrompt({ prompt: 'great, now add the tests', sessionId: 's1', repo: 'r1' });
  assert.strictEqual(out.correction, false);
  assert.deepStrictEqual(stats().r1, { hits: 1, misses: 0 });
  assert.deepStrictEqual(store.readInbox(), []);
  const r = store.loadRules()[0];
  const now = Date.now();
  assert.strictEqual(store.score(r, now, 'r1'), store.score(r, now));
  // hits offset earlier misses: 1 miss alone is 1/3 of base, 1 miss with 2 hits is 3/5
  assert.ok(store.score({ ...r, byRepo: { r1: { hits: 2, misses: 1 } } }, now, 'r1') > store.score({ ...r, byRepo: { r1: { hits: 0, misses: 1 } } }, now, 'r1'));
});

test('no previous turn means no change and no throw', () => {
  setup();
  assert.strictEqual(feedback.onPrompt({ prompt: 'no', sessionId: 'unknown', repo: 'r1' }), null);
  assert.strictEqual(feedback.onPrompt({}), null);
  assert.strictEqual(stats(), undefined);
});

test('score without repo stats equals the base score', () => {
  const now = Date.now();
  assert.strictEqual(store.score(rule, now, 'r1'), store.score(rule, now));
});
