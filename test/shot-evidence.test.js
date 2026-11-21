'use strict';
// A fallback screenshot is handed over only with evidence that the captured page shows the turn's change.
const test = require('node:test');
const assert = require('node:assert');
const shot = require('../lib/shot');

test('classesInHtml keeps the classes that appear in a class attribute, in any quoting', () => {
  const html = '<div class="card wide"><p class=\'fine\'>card-title</p><b class=bold>x</b></div>';
  assert.deepStrictEqual(shot.classesInHtml(html, ['wide', 'fine', 'bold', 'card-title', 'missing']), ['wide', 'fine', 'bold']);
  assert.deepStrictEqual(shot.classesInHtml('', ['a']), []);
  assert.deepStrictEqual(shot.classesInHtml('<i class="a">', undefined), []);
});
