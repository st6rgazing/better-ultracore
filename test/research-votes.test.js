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
