'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { retrieve, expand } = require('../lib/rules/retrieve');

const rule = (over = {}) => ({
  id: 'no-implicit-state',
  rule: 'Reset carried-over state when a new round starts.',
  pinned: false,
  when: { keywords: ['round', 'restart', 'reset', 'state', 'lobby', 'persist', 'hints'], paths: [], promptKinds: ['edit'] },
  check: {},
  hits: 0,
  misses: 0,
  ...over,
});
const ids = (prompt, rules = [rule()]) => retrieve({ prompt, rules }).matched.map((r) => r.id);

test('start-game prompt reaches a rule keyed on restart and reset', () => {
  assert.deepStrictEqual(ids('add an animation for when you press start game'), ['no-implicit-state']);
});

test('unrelated prompt still does not match', () => {
  assert.deepStrictEqual(ids('rename the helper in the date formatter'), []);
  assert.deepStrictEqual(ids('add a loading state to the profile page'), []);
});

test('two-signal rule holds: a synonym match with the wrong prompt kind does not fire', () => {
  assert.deepStrictEqual(ids('explain why start game is slow, do not change anything'), []);
});

test('synonym groups and stems map to rule keywords', () => {
  const sound = rule({ id: 'sound', when: { keywords: ['audio', 'sound'], paths: [], promptKinds: [] } });
  const layout = rule({ id: 'layout', when: { keywords: ['layout', 'size'], paths: [], promptKinds: [] } });
  const menu = rule({ id: 'menu', when: { keywords: ['dialog', 'menu'], paths: [], promptKinds: [] } });
  assert.deepStrictEqual(ids('fix the sfx volume', [sound, layout, menu]), ['sound']);
  assert.deepStrictEqual(ids('stop the board resizing on hover', [sound, layout, menu]), ['layout']);
  assert.deepStrictEqual(ids('tidy the options screen', [sound, layout, menu]), ['menu']);
  // a single stem or synonym hit is too weak on its own
  const one = rule({ id: 'one', when: { keywords: ['button'], paths: [], promptKinds: [] } });
  assert.deepStrictEqual(ids('add icons to the buttons', [one]), []);
  const w = expand('resetting rounds persisted');
  for (const k of ['reset', 'round', 'persist']) assert.ok(w.has(k), k);
});
