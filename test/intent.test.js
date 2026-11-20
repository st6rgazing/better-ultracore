'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { intentLine } = require('../lib/intent');

const root = path.join(__dirname, '..', 'bench');

test('fires on slight-tweak with a small-step clause', () => {
  const p = fs.readFileSync(path.join(root, 'cases', 'slight-tweak', 'prompt.txt'), 'utf8');
  const line = intentLine(p, { kind: 'small' });
  assert.match(line, /Read the request literally/);
  assert.match(line, /small step only/);
  assert.ok(line.length <= 240);
});

test('fires on every private bench prompt', (t) => {
  const dir = path.join(root, 'private');
  if (!fs.existsSync(dir)) return t.skip('bench/private absent');
  let n = 0;
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, 'prompt.txt');
    if (!fs.existsSync(f)) continue;
    const line = intentLine(fs.readFileSync(f, 'utf8'));
    assert.ok(line, d + ' should fire');
    assert.ok(line.length <= 240, d);
    n++;
  }
  if (!n) t.skip('no private prompts');
});

test('advice prompts get the show-or-explain line', () => {
  assert.match(intentLine('explain how the router works'), /show or explain/);
  assert.match(intentLine('make it better', { kind: 'review' }), /do not edit files/);
});

test('no degree clause without a degree word', () => {
  assert.doesNotMatch(intentLine('rename foo to bar'), /small step/);
});

test('silent when criteria present or prompt is long', () => {
  assert.strictEqual(intentLine('Fix login.\nAcceptance: user sees an error'), '');
  assert.strictEqual(intentLine('add a flag, it must print JSON'), '');
  assert.strictEqual(intentLine('change port. Run node --test'), '');
  assert.strictEqual(intentLine('make it work\n- a\n- b'), '');
  assert.strictEqual(intentLine(Array(70).fill('word').join(' ')), '');
  assert.strictEqual(intentLine(''), '');
});

test('sweep prompts get the sweep line, not the literal one', () => {
  for (const p of ['remove all traces of ai like this', 'look through the whole app and drop the beta label', 'rename Foo everywhere']) {
    const line = intentLine(p);
    assert.match(line, /every occurrence/, p);
    assert.doesNotMatch(line, /touch only what is named/, p);
  }
});

test('vague fix of a screen asks to infer the defect', () => {
  for (const p of ['can u fix the bug report screen', 'fix the settings page', 'improve this dialog']) {
    assert.match(intentLine(p), /names no defect/, p);
  }
  assert.doesNotMatch(intentLine('fix the overflow on the settings page'), /names no defect/);
});
