'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/rules/store');

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
