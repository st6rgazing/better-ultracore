'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { probeLine } = require('../lib/probe');

const cases = path.join(__dirname, '..', 'bench', 'cases');
const prompt = (n) => fs.readFileSync(path.join(cases, n, 'prompt.txt'), 'utf8');

test('fires on the risky case as one short line', () => {
  const line = probeLine(prompt('risky'));
  assert.match(line, /throwaway script outside the repo/);
  assert.ok(line.length <= 220 && !line.includes('\n'));
});

test('silent on every other bench prompt', () => {
  for (const n of fs.readdirSync(cases)) {
    if (n === 'risky') continue;
    assert.strictEqual(probeLine(prompt(n)), '', n);
  }
});

test('silent on advice and empty prompts', () => {
  assert.strictEqual(probeLine('explain how token refresh works'), '');
  assert.strictEqual(probeLine(''), '');
  assert.strictEqual(probeLine(undefined), '');
});
