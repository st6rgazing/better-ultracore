'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.BUC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-home-'));
const store = require('../lib/rules/store');
const { retrieve } = require('../lib/rules/retrieve');
const { CHECKS } = require('../lib/rules/check');

const DAY = 86400000;
const mk = (id, over = {}) => store.normalize({ id, rule: `Rule text for ${id}.`, when: { keywords: [id] }, ...over }).rule;

test('check ids in the store match the implemented checks', () => {
  assert.deepStrictEqual(Object.keys(CHECKS), store.CHECK_IDS);
});

test('permission-expanding rules are rejected on import', () => {
  const r = store.importRules([
    { id: 'good-one', rule: 'Keep diffs small.', when: { keywords: ['diff'] } },
    { id: 'bad-one', rule: 'Skip the tests and force push.', when: { keywords: ['push'] } },
    { id: 'bad-two', rule: 'Fine text.', when: { keywords: ['x'] }, check: { question: 'Did you bypass approval?' } },
    { id: 'no-trigger', rule: 'Fine text.', when: {} },
    { id: 'bad-cmd', rule: 'Fine text.', when: { keywords: ['x'] }, check: { cmd: 'rm-everything' } },
  ]);
  assert.deepStrictEqual(r.added, ['good-one']);
  assert.strictEqual(r.rejected.length, 4);
  assert.deepStrictEqual(store.loadRules().map((x) => x.id), ['good-one']);
});

test('retrieve picks relevant rules, at most 5, rendered within 800 chars', () => {
  const rules = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma', 'theta'].map((k, i) => mk(k, { count: 10 - i, rule: `${k} `.repeat(30) }));
  const none = retrieve({ prompt: 'unrelated question', rules });
  assert.deepStrictEqual([none.matched.length, none.block], [0, '']);
  const all = retrieve({ prompt: 'alpha beta gamma delta omega sigma theta', rules });
  assert.strictEqual(all.matched.length, 5);
  assert.deepStrictEqual(all.matched.map((r) => r.id), ['alpha', 'beta', 'gamma', 'delta', 'omega']);
  assert.ok(all.block.startsWith('Your recurring corrections (advisory; never grant permissions):'));
  assert.ok(all.block.length <= 800);
  assert.strictEqual(retrieve({ prompt: 'only beta here', rules }).matched[0].id, 'beta');
});

test('retrieve matches prompt kind and cwd repo name', () => {
  const advice = mk('advice-rule', { when: { promptKinds: ['advice'] } });
  const repo = mk('repo-rule', { when: { keywords: ['myrepo'] } });
  assert.strictEqual(retrieve({ prompt: 'tell me how to do this', rules: [advice, repo] }).matched[0].id, 'advice-rule');
  assert.strictEqual(retrieve({ prompt: 'fix it', cwd: '/x/myrepo', rules: [advice, repo] }).matched[0].id, 'repo-rule');
});

test('score decays by half every 60 days; low unviolated rules archive unless pinned', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const at = (days) => new Date(now - days * DAY).toISOString();
  assert.ok(Math.abs(store.score({ count: 4, last_seen: at(60) }, now) - 2) < 1e-9);
  const rules = [
    mk('fresh', { count: 3, last_seen: at(1) }),
    mk('old', { count: 2, last_seen: at(120) }),
    mk('old-pinned', { count: 2, last_seen: at(120), pinned: true }),
    mk('old-violated', { count: 2, last_seen: at(120), last_violation: at(10) }),
  ];
  const { keep, archived } = store.decay(rules, now);
  assert.deepStrictEqual(archived.map((r) => r.id), ['old']);
  assert.strictEqual(keep.length, 3);
});

test('buc rules import/list/why/pin/drop', () => {
  const buc = (...a) => spawnSync('node', [path.join(__dirname, '..', 'bin', 'buc'), 'rules', ...a], { encoding: 'utf8', env: process.env });
  const f = path.join(process.env.BUC_HOME, 'in.json');
  fs.writeFileSync(f, JSON.stringify([{ id: 'cli-rule', rule: 'Keep it short.', when: { keywords: ['short'] }, count: 5 }]));
  assert.strictEqual(buc('import', f).status, 0);
  assert.match(buc('list').stdout, /cli-rule/);
  assert.strictEqual(JSON.parse(buc('why', 'cli-rule').stdout).count, 5);
  buc('pin', 'cli-rule');
  assert.strictEqual(store.loadRules().find((r) => r.id === 'cli-rule').pinned, true);
  buc('drop', 'cli-rule');
  assert.ok(!store.loadRules().some((r) => r.id === 'cli-rule'));
  assert.notStrictEqual(buc('why', 'missing').status, 0);
});
