'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const intent = require('../lib/intent');
const { probeLine } = require('../lib/probe');

// The v12 default edit-prompt injection was the long SELF line, plus a 162-char runtime-effect probe line when it fired.
const V12_PROBE = 162;

test('the default intent line is at least 150 chars shorter than the v12 default', () => {
  const now = intent.intentLine('add a back button to the settings page');
  assert.strictEqual(now, intent.SELF_SHORT);
  assert.ok(intent.SELF.length - now.length >= 150, String(intent.SELF.length - now.length));
});

test('the runtime-effect probe line is at most 110 chars and still names the guards', () => {
  const line = probeLine('add a sound to the intro');
  assert.ok(line.length <= 110, String(line.length));
  assert.match(line, /unlock, mute, permission/);
  const before = intent.SELF.length + V12_PROBE;
  const now = intent.intentLine('add a sound to the intro').length + line.length;
  assert.ok(before - now >= 150, String(before - now));
});

test('"intent": "self-long" in .claude/buc.json keeps the long line reachable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-v13-'));
  assert.strictEqual(intent.intentMode(dir), 'self');
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'buc.json'), JSON.stringify({ intent: 'self-long' }));
  assert.strictEqual(intent.intentMode(dir), 'self-long');
  assert.strictEqual(intent.intentLine('add a back button to the settings page', { mode: 'self-long' }), intent.SELF);
});
