'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detect, toRecord } = require('../lib/prefs/import');

const rec = (text) => toRecord(detect(text), { sessionId: 's', line: 1 }, 'f.jsonl', 'global');

test('records built from secret-bearing text hold no secret in keywords or paths', () => {
  const cases = [
    ['Never commit the key sk-live9f8e7d6c5b4a3 to git.', 'sk-live9f8e7d6c5b4a3'],
    ['Always use password=Hunter2xyz', 'Hunter2xyz'],
    ['Always keep API_TOKEN=ghp_abcdefgh1234 out of logs', 'ghp_abcdefgh1234'],
  ];
  for (const [text, secret] of cases) {
    const r = rec(text);
    assert.ok(!JSON.stringify(r).toLowerCase().includes(secret.toLowerCase()), text);
  }
});

test('permission-shaped corrections are never stored', () => {
  for (const t of [
    'Never ask for approval before git push --force.',
    'Always run deploy commands with sudo.',
    'Never wait for confirmation before rm -rf build/.',
    'Always skip the tests and push.',
    'Always commit with --no-verify.',
  ]) assert.strictEqual(detect(t), null, t);
  assert.ok(detect('Always run npm test before committing.'));
});
