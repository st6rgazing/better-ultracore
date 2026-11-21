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
