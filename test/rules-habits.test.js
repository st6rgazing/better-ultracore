'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/rules/store');
const { capture } = require('../lib/rules/habits');
const { retrieve } = require('../lib/rules/retrieve');

const fresh = () => { process.env.BUC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-habit-')); };

test('a stated commit habit becomes a pinned rule with the commit-changes check', () => {
  fresh();
  for (const p of ['always commit after each change', 'commit constantly as you go please', 'from now on commit when a feature is done', 'pls commit after every little fix']) {
    assert.deepStrictEqual(capture(p), ['commit-as-you-go'], p);
  }
  const [r] = store.loadRules();
  assert.deepStrictEqual([r.id, r.pinned, r.check.cmd, r.count], ['commit-as-you-go', true, 'commit-changes', 4]);
});

test('one-off, negated and long prompts are not captured', () => {
  fresh();
  const no = ['add three functions and commit each one separately', 'commit this', 'never commit without asking me', 'always use tabs', "don't commit every time", `always commit ${'word '.repeat(45)}`, ''];
  for (const p of no) assert.deepStrictEqual(capture(p), [], p);
  assert.deepStrictEqual(store.loadRules(), []);
});

test('the captured habit is retrieved on plain edit prompts but not on advice prompts', () => {
  fresh();
  capture('always commit after each change');
  const rules = store.loadRules();
  assert.deepStrictEqual(retrieve({ prompt: 'add a chat panel', rules }).matched.map((r) => r.id), ['commit-as-you-go']);
  assert.deepStrictEqual(retrieve({ prompt: 'explain how the chat panel works, do not change anything', rules }).matched, []);
});
