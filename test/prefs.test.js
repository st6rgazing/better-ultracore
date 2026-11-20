'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/prefs/store');
const { importFiles } = require('../lib/prefs/import');
const { retrieve, HEADER } = require('../lib/prefs/retrieve');

const FIX = path.join(__dirname, '..', 'fixtures', 'transcripts');
const FILES = ['s1', 's2', 's3'].map((n) => path.join(FIX, `${n}.jsonl`));

function setup() {
  process.env.BUC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-home-'));
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buc-repo-'));
}

function importAll(repo) {
  const recs = importFiles(FILES, { scope: `project:${repo}`, existing: store.loadAll(repo), forgotten: store.tombstones(repo) });
  recs.forEach((r) => store.save(r, repo));
  return recs;
}

const byText = (recs, re) => recs.find((r) => re.test(r.correction));

test('import yields expected records and ignores tool_result', () => {
  const recs = importAll(setup());
  assert.equal(recs.length, 6);
  assert.equal(byText(recs, /npm test/).status, 'confirmed');
  assert.equal(byText(recs, /look at main/i).check, 'verify exact remote commit: git ls-remote origin main equals the SHA you inspected');
  assert.equal(byText(recs, /refresh/i).check, 'suggest browser test: reload page and verify state persisted');
  assert.ok(!recs.some((r) => /ignored tool output/.test(r.correction)));
});

test('fake secret never reaches the store file', () => {
  const repo = setup();
  importAll(repo);
  const raw = fs.readFileSync(store.filesFor(repo).prefs, 'utf8');
  assert.ok(!raw.includes('FAKE0000'));
  assert.ok(!raw.includes('sk-test'));
});

test('same correction in two sessions becomes a suggested check', () => {
  const rec = byText(importAll(setup()), /code snippets minimal/i);
  assert.deepEqual(rec.sessions, ['s1', 's2']);
  assert.equal(rec.kind, 'check');
  assert.equal(rec.status, 'suggested');
});

test('forgotten record is tombstoned and never re-imported', () => {
  const repo = setup();
  const rec = byText(importAll(repo), /npm test/);
  assert.ok(store.forget(rec.id, repo));
  const again = importAll(repo);
  assert.ok(!again.some((r) => r.id === rec.id));
  assert.ok(!store.loadAll(repo).some((r) => r.id === rec.id));
});
