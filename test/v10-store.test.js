'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/rules/store');
const handsoff = require('../lib/handsoff');

const fresh = () => { process.env.BUC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-v10-')); return process.env.BUC_HOME; };
const withEnv = (vars, fn) => {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
};

test('now() honours BUC_NOW as an ISO date or epoch ms, else the wall clock', () => {
  withEnv({ BUC_NOW: '2026-01-02T03:04:05.000Z' }, () => assert.strictEqual(store.now(), Date.parse('2026-01-02T03:04:05.000Z')));
  withEnv({ BUC_NOW: '1700000000000' }, () => assert.strictEqual(store.now(), 1700000000000));
  withEnv({ BUC_NOW: 'garbage' }, () => assert.ok(Math.abs(store.now() - Date.now()) < 5000));
  withEnv({ BUC_NOW: undefined }, () => assert.ok(Math.abs(store.now() - Date.now()) < 5000));
});

test('BUC_NOW sets the default time of new rules', () => {
  fresh();
  withEnv({ BUC_NOW: '2026-01-02T03:04:05.000Z' }, () => {
    store.importRules([{ id: 'a-rule', rule: 'Do the thing.', when: { keywords: ['thing'] } }]);
    assert.strictEqual(store.loadRules()[0].last_seen, '2026-01-02T03:04:05.000Z');
  });
});

test('off() reads BUC_OFF and the repo buc.json off list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-off-'));
  withEnv({ BUC_OFF: undefined }, () => assert.strictEqual(store.off('self', root), false));
  withEnv({ BUC_OFF: 'self, wide-diff' }, () => {
    assert.strictEqual(store.off('self', root), true);
    assert.strictEqual(store.off('Wide-Diff', root), true);
    assert.strictEqual(store.off('typecheck', root), false);
  });
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'buc.json'), JSON.stringify({ off: ['typecheck'] }));
  withEnv({ BUC_OFF: 'self' }, () => {
    assert.strictEqual(store.off('typecheck', root), true);
    assert.strictEqual(store.off('self', root), true);
    assert.strictEqual(store.off('ui', root), false);
  });
  fs.writeFileSync(path.join(root, '.claude', 'buc.json'), JSON.stringify({ off: 'ui,shot' }));
  withEnv({ BUC_OFF: undefined }, () => assert.strictEqual(store.off('shot', root), true));
  fs.writeFileSync(path.join(root, '.claude', 'buc.json'), '{broken');
  withEnv({ BUC_OFF: undefined }, () => assert.strictEqual(store.off('shot', root), false));
});

test('repoState is empty for an unknown repo and reads repos.json', () => {
  const home = fresh();
  assert.deepStrictEqual(store.repoState('nope'), { events: [] });
  fs.writeFileSync(path.join(home, 'repos.json'), JSON.stringify({ r1: { handsOff: 'on' } }));
  assert.deepStrictEqual(store.repoState('r1'), { handsOff: 'on', events: [] });
  fs.writeFileSync(path.join(home, 'repos.json'), 'not json');
  assert.deepStrictEqual(store.repoState('r1'), { events: [] });
});

test('recordRepo appends named events per repo, caps them and never stores text', () => {
  const home = fresh();
  const st = store.recordRepo('r1', 'handsoff', 's1', '2026-03-01T00:00:00.000Z');
  assert.deepStrictEqual(st.events, [{ e: 'handsoff', s: 's1', ts: '2026-03-01T00:00:00.000Z' }]);
  store.recordRepo('r1', 'edit', 's2', Date.parse('2026-03-02T00:00:00.000Z'));
  store.recordRepo('r2', 'edit', 's3');
  assert.deepStrictEqual(store.repoState('r1').events.map((e) => [e.e, e.s, e.ts]), [['handsoff', 's1', '2026-03-01T00:00:00.000Z'], ['edit', 's2', '2026-03-02T00:00:00.000Z']]);
  assert.strictEqual(store.repoState('r2').events.length, 1);
  assert.strictEqual(store.recordRepo('', 'edit', 's1'), null);
  assert.strictEqual(store.recordRepo('r1', '', 's1'), null);
  for (let i = 0; i < 410; i++) store.recordRepo('r3', 'edit', 's', 1700000000000 + i);
  assert.strictEqual(store.repoState('r3').events.length, 400);
  assert.deepStrictEqual(Object.keys(store.repoState('r3').events[0]).sort(), ['e', 's', 'ts']);
  fs.writeFileSync(path.join(home, 'repos.json'), '{broken');
  assert.strictEqual(store.recordRepo('r1', 'edit', 's1'), null);
  assert.strictEqual(fs.readFileSync(path.join(home, 'repos.json'), 'utf8'), '{broken');
});

test('recordRepo defaults its time to BUC_NOW', () => {
  fresh();
  withEnv({ BUC_NOW: '2026-05-05T00:00:00.000Z' }, () => store.recordRepo('r1', 'edit', 's1'));
  assert.strictEqual(store.repoState('r1').events[0].ts, '2026-05-05T00:00:00.000Z');
});

test('setRepo sets and removes fields and keeps events', () => {
  fresh();
  store.recordRepo('r1', 'edit', 's1', 1700000000000);
  assert.strictEqual(store.setRepo('r1', { handsOff: 'on', events: [] }).handsOff, 'on');
  assert.strictEqual(store.repoState('r1').events.length, 1);
  store.setRepo('r1', { handsOff: undefined });
  assert.ok(!('handsOff' in store.repoState('r1')));
  assert.strictEqual(store.setRepo('', { handsOff: 'on' }), null);
});

test('saveLastTurn keeps head and files, and a call without rules merges', () => {
  fresh();
  store.saveLastTurn('s1', { rules: ['a'], repo: 'r1', ts: 5 });
  assert.deepStrictEqual(store.loadLastTurn('s1'), { rules: ['a'], repo: 'r1', ts: 5 });
  store.saveLastTurn('s1', { head: 'abc', files: { 'src/a.js': 'h1', 'new.js': null } });
  assert.deepStrictEqual(store.loadLastTurn('s1'), { rules: ['a'], repo: 'r1', ts: 5, head: 'abc', files: { 'src/a.js': 'h1', 'new.js': null } });
  store.saveLastTurn('s1', { rules: ['b'], repo: 'r1', ts: 6 });
  assert.deepStrictEqual(store.loadLastTurn('s1'), { rules: ['b'], repo: 'r1', ts: 6 });
  store.saveLastTurn('s2', { rules: [], repo: 'r1', ts: 7, head: 'h', files: {} });
  assert.deepStrictEqual(store.loadLastTurn('s2'), { rules: [], repo: 'r1', ts: 7, head: 'h', files: {} });
});

test('patchTurn merges v10 fields into the turn file and creates it when missing', () => {
  fresh();
  store.writeTurn('s1', { session_id: 's1', checks: ['typecheck'], intent: 'SELF' });
  assert.deepStrictEqual(store.patchTurn('s1', { toolCalls: 3, shotAt: 9 }), { session_id: 's1', checks: ['typecheck'], intent: 'SELF', toolCalls: 3, shotAt: 9 });
  assert.strictEqual(store.readTurn('s1').toolCalls, 3);
  assert.deepStrictEqual(store.patchTurn('s2', { toolCalls: 1 }), { session_id: 's2', toolCalls: 1 });
  assert.deepStrictEqual(store.readTurn('s2'), { session_id: 's2', toolCalls: 1 });
});

test('hands-off statements and apply prompts are recognised narrowly', () => {
  for (const p of ["don't change anything, what is wrong with the header?", 'undo your changes', 'Just show me the css', 'just tell me which file', 'show me how to add a route', 'do not edit anything yet']) assert.ok(handsoff.isStatement(p), p);
  for (const p of ['make the header blue', "don't change the footer", 'show me the result when done', 'undo the last commit', '']) assert.ok(!handsoff.isStatement(p), p);
  for (const p of ['apply', 'ok, do it', 'Go ahead', 'yes please apply that']) assert.ok(handsoff.isApply(p), p);
  for (const p of ['can you apply the theme to the footer', 'what would you do', '']) assert.ok(!handsoff.isApply(p), p);
});
