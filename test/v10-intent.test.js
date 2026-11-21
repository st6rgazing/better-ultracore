'use strict';
const test = require('node:test');
const assert = require('node:assert');
const intent = require('../lib/intent');

test('the misread line has an exit when no other reading fits', () => {
  const line = intent.correctionLine('no thats not what i meant', true);
  assert.match(line, /different reading/);
  assert.match(line, /If no other reading fits the user's words, change nothing: show the exact before and after/);
  assert.ok(line.length <= 400, String(line.length));
});
