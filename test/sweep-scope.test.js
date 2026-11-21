'use strict';
// A request that names the whole app and ends in a narrow diff gets one soft Stop note.
const test = require('node:test');
const assert = require('node:assert');
const { sweepPhrase } = require('../lib/intent');

test('sweepPhrase returns the whole-scope words of a prompt, and nothing for a pasted block or a plain request', () => {
  assert.strictEqual(sweepPhrase('look through the Whole App and tidy the labels'), 'whole app');
  assert.strictEqual(sweepPhrase('rename it everywhere'), 'everywhere');
  assert.strictEqual(sweepPhrase('remove all traces of the old logo'), 'all traces');
  assert.strictEqual(sweepPhrase('fix every page title'), 'every page');
  assert.strictEqual(sweepPhrase('make the save button blue'), '');
  assert.strictEqual(sweepPhrase('<pasted>shown everywhere</pasted>\nmake the save button blue'), '');
  assert.strictEqual(sweepPhrase(undefined), '');
});
