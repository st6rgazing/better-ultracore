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
  for (const n of fs.readdirSync(cases).filter((d) => fs.existsSync(path.join(cases, d, 'prompt.txt')))) {
    if (n === 'risky') continue;
    assert.strictEqual(probeLine(prompt(n)), '', n);
  }
});

test('silent on advice and empty prompts', () => {
  assert.strictEqual(probeLine('explain how token refresh works'), '');
  assert.strictEqual(probeLine(''), '');
  assert.strictEqual(probeLine(undefined), '');
});

test('runtime-effect changes get the liveness line; risky wins when both match', () => {
  const { probeLine } = require('../lib/probe');
  assert.match(probeLine('add a sound to the intro'), /guards .unlock, mute, permission. that stop it firing/);
  assert.match(probeLine('make a toast show after saving'), /runtime effect/);
  assert.strictEqual(probeLine('explain the audio code'), '');
  assert.match(probeLine('fix token parsing and add a toast'), /throwaway script/);
});
