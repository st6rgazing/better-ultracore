'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { promptKind } = require('../lib/rules/retrieve');

test('prompts that ask for a change are not advice', () => {
  for (const p of ['Fix a.js and explain why it broke', 'Add tips to the README', 'Why does the build fail? fix it']) {
    assert.strictEqual(promptKind(p), 'edit', p);
  }
});

test('prompts with no change verb stay advice', () => {
  assert.strictEqual(promptKind('tell me how to simplify this UI'), 'advice');
});
