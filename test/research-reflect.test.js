'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reflect = require('../lib/reflect');
const store = require('../lib/rules/store');

function withHome(fn, env = {}) {
  const keys = ['BUC_HOME', 'BUC_OFF', 'BUC_NOW', ...Object.keys(env)];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { BUC_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'buc-reflect-')), BUC_OFF: '', BUC_NOW: '2026-11-01T00:00:00Z', ...env });
  try { return fn(process.env.BUC_HOME); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('every reflection template is a valid rule of at most 25 words', () => {
  for (const [k, t] of Object.entries(reflect.TEMPLATES)) {
    const { rule, error } = store.normalize({ id: `reflect-${k}`, rule: t.rule, when: { keywords: t.keywords, promptKinds: t.promptKinds } });
    assert.strictEqual(error, undefined, k);
    assert.ok(rule.rule.split(/\s+/).length <= 25, k);
    assert.match(rule.rule, /^You assumed .*; the user (wanted|still|rejected)|^You assumed a reading the user rejected/, k);
  }
});

test('read returns nothing without a file and skips broken lines', () => withHome(() => {
  assert.deepStrictEqual(reflect.read(), []);
  fs.writeFileSync(reflect.file(), '{"k":"still"}\nnot json\n');
  assert.deepStrictEqual(reflect.read(), [{ k: 'still' }]);
}));

const cand = (k, s, repo = 'r1') => ({ k, s, repo, h: 'aaaaaaaaaaaa', ts: '2026-10-01T00:00:00.000Z' });

test('due needs three candidates of one pattern in one repo from two sessions', () => {
  assert.deepStrictEqual(reflect.due([cand('still', 'a'), cand('still', 'b')], 'r1'), []);
  assert.deepStrictEqual(reflect.due([cand('still', 'a'), cand('still', 'a'), cand('still', 'a')], 'r1'), []);
  assert.deepStrictEqual(reflect.due([cand('still', 'a'), cand('still', 'a'), cand('still', 'b')], 'r1'), ['still']);
  assert.deepStrictEqual(reflect.due([cand('still', 'a'), cand('still', 'b'), cand('still', 'c', 'r2')], 'r1'), []);
  assert.deepStrictEqual(reflect.due([cand('still', 'a'), cand('misread', 'b'), cand('overshoot', 'c')], 'r1'), []);
  assert.deepStrictEqual(reflect.due([cand('nope', 'a'), cand('nope', 'b'), cand('nope', 'c')], 'r1'), []);
});

const seed = (list) => fs.writeFileSync(reflect.file(), list.map((c) => `${JSON.stringify(c)}\n`).join(''));

test('promote stores a repo-scoped rule with hash-only sources and uses up its candidates', () => withHome(() => {
  assert.deepStrictEqual(reflect.promote('r1'), []);
  seed([cand('overshoot', 'a'), cand('overshoot', 'a'), cand('overshoot', 'b'), cand('still', 'a'), cand('overshoot', 'z', 'r2')]);
  assert.deepStrictEqual(reflect.promote('r1'), ['reflect-overshoot']);
  const [rule] = store.loadRules();
  assert.deepStrictEqual([rule.id, rule.origin, rule.count, rule.scope, rule.pinned], ['reflect-overshoot', 'learn', 3, { repos: ['r1'] }, false]);
  assert.deepStrictEqual(Object.keys(rule.sources[0]).sort(), ['h', 'repo', 'session', 'ts']);
  assert.deepStrictEqual(reflect.read().map((c) => [c.k, c.repo]), [['still', 'r1'], ['overshoot', 'r2']]);
  assert.deepStrictEqual(reflect.promote('r1'), [], 'nothing left to promote');
  seed([cand('overshoot', 'a', 'r2'), cand('overshoot', 'b', 'r2'), cand('overshoot', 'c', 'r2')]);
  assert.deepStrictEqual(reflect.promote('r2'), ['reflect-overshoot']);
  assert.deepStrictEqual(store.loadRules()[0].scope, { repos: ['r1', 'r2'] });
}));

test('capture keeps a hash and never the text, and promotes on the third sighting', () => withHome((home) => {
  const say = (sessionId, prompt = 'no, way too big, I said slightly') => reflect.capture({ pattern: 'overshoot', prompt, sessionId, repo: 'r1' });
  assert.deepStrictEqual(say('a'), { stored: true, promoted: [] });
  assert.deepStrictEqual(Object.keys(reflect.read()[0]).sort(), ['h', 'k', 'repo', 's', 'ts']);
  assert.strictEqual(reflect.read()[0].h, store.hash('no, way too big, I said slightly'));
  assert.ok(!fs.readFileSync(reflect.file(), 'utf8').includes('too big'));
  assert.deepStrictEqual(say('a'), { stored: true, promoted: [] });
  assert.deepStrictEqual(say('b'), { stored: true, promoted: ['reflect-overshoot'] });
  assert.ok(!JSON.stringify(store.loadRules()).includes('too big'));
  for (const bad of [{ pattern: '' }, { pattern: 'self' }, { pattern: 'still', repo: '' }, { pattern: 'still', sessionId: '' }, undefined]) {
    assert.deepStrictEqual(reflect.capture(bad && { prompt: 'x', sessionId: 's', repo: 'r1', ...bad }), { stored: false, promoted: [] });
  }
  process.env.BUC_OFF = 'reflect';
  assert.deepStrictEqual(say('c'), { stored: false, promoted: [] });
  assert.ok(home);
}));

test('the prompt hook captures a reflection for a correction in a repo and none for a first prompt', () => withHome(() => {
  const { execFileSync } = require('node:child_process');
  const inject = require('../hooks/inject');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'buc-reflect-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  inject.run({ prompt: 'make the logo a bit bigger', cwd: dir, session_id: 'p', transcript_path: '' });
  assert.deepStrictEqual(reflect.read(), []);
  inject.run({ prompt: 'way too big', cwd: dir, session_id: 'p', transcript_path: '' });
  assert.deepStrictEqual(reflect.read().map((c) => [c.k, c.s]), [['overshoot', 'p']]);
}));
