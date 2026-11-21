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

test('the guide-icons and house-rules prompt shapes get the self-classification line', () => {
  const shapes = [
    'change the help symbol to be a ! and change the history symbol to the current help one',
    'make it so anyone who is not an admin sees every option but cannot edit it, greyed out',
    'rename x in src/a.js',
    'just one button',
    'add a back button to the settings page',
  ];
  for (const p of shapes) {
    const r = intent.readIntent(p);
    assert.strictEqual(r.line, intent.SELF, p);
    assert.strictEqual(r.name, 'SELF', p);
    assert.strictEqual(r.pattern, 'self', p);
  }
});

test('the self line names the four readings and fits its cap', () => {
  for (const line of [intent.SELF, intent.SELF_SHORT]) {
    for (const word of ['EXACT', 'FEATURE', 'SWEEP', 'SHOW']) assert.match(line, new RegExp(`\\b${word} \\(`));
    assert.match(line, /first line/);
    assert.match(line, /[Dd]o not ask\.$/);
  }
  assert.ok(intent.SELF.length <= 420, String(intent.SELF.length));
  assert.ok(intent.SELF_SHORT.length <= 250, String(intent.SELF_SHORT.length));
});

test('precise patterns keep their fixed line', () => {
  const cases = [
    ['make the card slightly smaller', 'degree', 'EXACT', /small step only/],
    ['move the logo up a bit', 'degree', 'EXACT', /Read the request literally/],
    ['only change the title in src/header.js', 'narrow-path', 'EXACT', /touch only what is named\.$/],
    ['rename Foo everywhere', 'sweep', 'SWEEP', /every occurrence/],
    ['explain how the router works', 'show', 'SHOW', /do not edit files/],
    ['fix the settings page', 'vague', 'FEATURE', /names no defect/],
  ];
  for (const [p, pattern, name, re] of cases) {
    const r = intent.readIntent(p);
    assert.strictEqual(r.pattern, pattern, p);
    assert.strictEqual(r.name, name, p);
    assert.match(r.line, re, p);
  }
  assert.strictEqual(intent.readIntent('tell me how to simplify this, dont change anything', { kind: 'advice' }).name, 'SHOW');
});

test('loose degree and narrowing words no longer choose a line', () => {
  const loose = ['add more tests', 'add a little icon to the header', 'add a bit of padding', 'show less text in the form', 'fix only 1 and 2', 'can you just add a footer', 'use and/or in the label'];
  for (const p of loose) assert.strictEqual(intent.readIntent(p).pattern, 'self', p);
});

test('silent on criteria, long prompts and a bare go-ahead', () => {
  for (const p of ['', 'add a flag, it must print JSON', Array(70).fill('word').join(' '), 'go ahead', 'ok do it']) {
    assert.deepStrictEqual(intent.readIntent(p), { name: '', line: '', pattern: '' }, p);
  }
});

test('the pattern table is exported with what the eval needs', () => {
  assert.deepStrictEqual(intent.PRECISE.map((p) => p.id), ['show', 'vague', 'sweep', 'degree', 'narrow-path']);
  for (const p of intent.PRECISE) {
    assert.strictEqual(typeof p.test, 'function', p.id);
    assert.ok(Array.isArray(p.gold) && p.gold.length, p.id);
    assert.ok(['kind', 'text'].includes(p.on), p.id);
    assert.ok(p.line('x').length <= 240, p.id);
  }
});

test('regex mode restores the v9 lines', () => {
  const line = (p) => intent.intentLine(p, { mode: 'regex' });
  assert.match(line('change the help symbol to be a ! and the history symbol to the help one'), /touch only what is named/);
  assert.match(line('add a back button to the settings page'), /where the user will see it/);
  assert.match(line('add more tests'), /small step only/);
  assert.strictEqual(intent.readIntent('add a footer', { mode: 'regex' }).name, 'FEATURE');
});
