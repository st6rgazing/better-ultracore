'use strict';
const test = require('node:test');
const assert = require('node:assert');
const orch = require('../lib/orchestrate');

test('keywordUse tells an opt-in from a mention in quotes, code, a name or as the subject', () => {
  const optin = ['ultracode fix the login bug', 'refactor the parser, ultracode', 'Ultracode: migrate the store to sqlite', 'please ultracode this', 'fix the "ultracode" typo in the banner. ultracode'];
  for (const p of optin) assert.strictEqual(orch.keywordUse(p), 'optin', p);
  const mention = [
    'what is ultracode?', 'does ultracode use more tokens', 'rename the "ultracode" flag to deep', 'grep for `ultracode` in the repo',
    'open docs/ultracode.md', 'fix the better-ultracode README', 'do this without ultracode', 'why did the ultracode workflow launch',
    'ultracode mode burned my limit, explain', 'the ultracode keyword triggers by accident', "ultracode's docs are wrong", 'don\'t use ultracode here',
    'remove the word ultracode from the banner', '```\nultracode run\n```\nwhat does this print',
  ];
  for (const p of mention) assert.strictEqual(orch.keywordUse(p), 'mention', p);
  for (const p of ['fix the login bug', '', undefined]) assert.strictEqual(orch.keywordUse(p), 'none', String(p));
});
