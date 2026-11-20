'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const STORE = path.join(__dirname, '..', 'lib', 'rules', 'store.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rule = { id: 'a-rule', rule: 'R.', when: { keywords: ['x'] }, check: {}, kind: 'process', count: 1, last_seen: new Date().toISOString(), violations: 0, pinned: false };

test('concurrent bumps never leave rules.json empty or invalid', async () => {
  const home = tmp('buc-conc-');
  fs.writeFileSync(path.join(home, 'rules.json'), JSON.stringify([rule]));
  const seen = [];
  const watcher = setInterval(() => { try { seen.push(fs.readFileSync(path.join(home, 'rules.json'), 'utf8')); } catch { /* mid-rename */ } }, 1);
  await Promise.all(Array.from({ length: 30 }, () => new Promise((resolve) => {
    spawn('node', ['-e', `require(${JSON.stringify(STORE)}).bump(['a-rule'])`], { env: { ...process.env, BUC_HOME: home } }).on('close', resolve);
  })));
  clearInterval(watcher);
  for (const text of seen) assert.strictEqual(JSON.parse(text).length, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'rules.json'), 'utf8')).length, 1);
});

test('update leaves an unparseable rules.json untouched', () => {
  const prev = process.env.BUC_HOME;
  const home = tmp('buc-bad-');
  fs.writeFileSync(path.join(home, 'rules.json'), '{broken');
  process.env.BUC_HOME = home;
  try { require(STORE).bump(['a-rule']); } finally { process.env.BUC_HOME = prev; }
  assert.strictEqual(fs.readFileSync(path.join(home, 'rules.json'), 'utf8'), '{broken');
});
