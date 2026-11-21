'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const votes = require('../lib/rules/votes');
const store = require('../lib/rules/store');

function withHome(fn, env = {}) {
  const keys = ['BUC_HOME', 'BUC_OFF', 'BUC_NOW', ...Object.keys(env)];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { BUC_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'buc-votes-')), BUC_OFF: '', BUC_NOW: '2026-11-01T00:00:00Z', ...env });
  try { return fn(process.env.BUC_HOME); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const rule = (id, extra = {}) => ({ id, rule: `do ${id}`, when: { keywords: [id.replace(/-/g, '')] }, count: 3, ...extra });

test('a rule starts at 2 votes, gains one without a correction and loses one with it, within 0 to 10', () => {
  assert.strictEqual(votes.votesOf({}), 2);
  assert.strictEqual(votes.next({}, false), 3);
  assert.strictEqual(votes.next({}, true), 1);
  assert.strictEqual(votes.next({ votes: 1 }, true), 0);
  assert.strictEqual(votes.next({ votes: 0 }, true), 0);
  assert.strictEqual(votes.next({ votes: 10 }, false), 10);
});

test('split drops unpinned rules at zero votes and the lowest-scored beyond 30', () => withHome(() => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  const base = { last_seen: '2026-11-01T00:00:00.000Z' };
  const rules = [rule('zero', { ...base, votes: 0 }), rule('zero-pinned', { ...base, votes: 0, pinned: true }), rule('fine', { ...base, votes: 1 })];
  const a = votes.split(rules, now);
  assert.deepStrictEqual([a.keep.map((r) => r.id), a.out.map((r) => r.id)], [['zero-pinned', 'fine'], ['zero']]);
  const many = Array.from({ length: 33 }, (_, i) => rule(`r${String(i).padStart(2, '0')}`, { ...base, count: i + 1 }));
  many[0].pinned = true;
  const b = votes.split(many, now);
  assert.strictEqual(b.keep.length, 30);
  assert.deepStrictEqual(b.out.map((r) => r.id), ['r01', 'r02', 'r03'], 'the lowest counts go, the pinned one stays');
}));

test('evict moves dropped rules to the archive and leaves a clean store untouched', () => withHome((home) => {
  assert.deepStrictEqual(votes.evict(), []);
  store.importRules([rule('stays'), rule('goes')]);
  store.updateRules(['goes'], (r) => { r.votes = 0; });
  assert.deepStrictEqual(votes.evict(), ['goes']);
  assert.deepStrictEqual(store.loadRules().map((r) => r.id), ['stays']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'rules.archive.json'), 'utf8')).map((r) => r.id), ['goes']);
  assert.deepStrictEqual(votes.evict(), []);
}));
