'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../lib/prefs/store');
const { importFiles, detect, toRecord } = require('../lib/prefs/import');

const BUC = path.join(__dirname, '..', 'bin', 'buc');
const FIX = path.join(__dirname, '..', 'fixtures', 'transcripts');
const FILES = ['s1', 's2', 's3'].map((n) => path.join(FIX, `${n}.jsonl`));

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'buc-repo-')));
  const prev = process.env.BUC_HOME;
  process.env.BUC_HOME = home;
  const recs = importFiles(FILES, { scope: `project:${repo}`, existing: [], forgotten: store.tombstones(repo) });
  recs.forEach((r) => store.save(r, repo));
  process.env.BUC_HOME = prev;
  const prefs = (...a) => spawnSync('node', [BUC, 'prefs', ...a], { cwd: repo, encoding: 'utf8', env: { ...process.env, BUC_HOME: home } });
  return { repo, recs, prefs, home };
}

test('import stores at most 200 chars of a 500-char correction', () => {
  const long = `Always run npm test before committing ${'x'.repeat(500)}`.slice(0, 500);
  const r = toRecord(detect(long), { sessionId: 's', line: 1 }, 'f.jsonl', 'global');
  assert.ok(r.correction.length <= 200);
});

test('prefs why shows source file and line, scope and trigger', () => {
  const { recs, prefs, repo } = setup();
  const rec = recs.find((r) => /look at main/i.test(r.correction));
  const out = prefs('why', rec.id);
  assert.equal(out.status, 0);
  assert.ok(out.stdout.includes(`${rec.source.file}:${rec.source.line}`));
  assert.ok(out.stdout.includes(`project:${repo}`));
  assert.match(out.stdout, /trigger: keywords \[.*\], paths \[.*\]/);
});

test('prefs scope <id> global moves the record to global scope', () => {
  const { recs, prefs } = setup();
  const rec = recs.find((r) => /npm test/.test(r.correction));
  const out = prefs('scope', rec.id, 'global');
  assert.equal(out.status, 0);
  assert.match(out.stdout, /scope -> global/);
  assert.match(prefs('list').stdout, new RegExp(`\\[${rec.id}\\] \\(confirmed, global,`));
});

test('prefs confirm --blocker refuses a single-session record unless --force', () => {
  const { recs, prefs } = setup();
  const rec = recs.find((r) => /look at main/i.test(r.correction));
  assert.equal(rec.sessions.length, 1);
  const refused = prefs('confirm', rec.id, '--blocker');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /seen in 1 session/);
  const forced = prefs('confirm', rec.id, '--blocker', '--force');
  assert.equal(forced.status, 0);
  assert.match(forced.stdout, /now a blocker/);
});

test('prefs confirm --blocker accepts a record seen in two sessions', () => {
  const { recs, prefs, repo, home } = setup();
  const rec = recs.find((r) => /look at main/i.test(r.correction));
  const prev = process.env.BUC_HOME;
  process.env.BUC_HOME = home;
  store.save({ ...rec, sessions: ['s1', 's2'] }, repo);
  process.env.BUC_HOME = prev;
  assert.equal(prefs('confirm', rec.id, '--blocker').status, 0);
});
