'use strict';
const test = require('node:test');
const assert = require('node:assert');
const orch = require('../lib/orchestrate');

test('keywordUse tells an opt-in from a mention in quotes, code, a name or as the subject', () => {
  const optin = ['ultracode fix the login bug', 'refactor the parser, ultracode', 'Ultracode: migrate the store to sqlite', 'please ultracode this', 'fix the "ultracode" typo in the banner. ultracode'];
  for (const p of optin) assert.strictEqual(orch.keywordUse(p), 'optin', p);
  const mention = [
    'what is ultracode?', 'does ultracode use more tokens', 'rename the "ultracode" flag to deep', 'grep for `ultracode` in the repo',
    'open docs/ultracode.md', 'fix the better-ultracode README', 'do this without ultracode', 'why did the ultracode workflow launch',
    'ultracode mode burned my limit, explain', 'the ultracode keyword triggers by accident', "ultracode's docs are wrong", 'don\'t use ultracode here',
    'remove the word ultracode from the banner', '```\nultracode run\n```\nwhat does this print',
  ];
  for (const p of mention) assert.strictEqual(orch.keywordUse(p), 'mention', p);
  for (const p of ['fix the login bug', '', undefined]) assert.strictEqual(orch.keywordUse(p), 'none', String(p));
});

test('isSmall is true for one short request and false for lists, breadth and long prompts', () => {
  for (const p of ['ultracode fix the typo in the footer', 'make the button blue', 'ultracode add a --json flag to the status command']) assert.strictEqual(orch.isSmall(p), true, p);
  const big = ['ultracode refactor the whole store', 'ultracode\n1. add login\n2. add logout', 'fix every page that uses the old header', `ultracode ${'word '.repeat(30)}`, 'ultracode', ''];
  for (const p of big) assert.strictEqual(orch.isSmall(p), false, p);
});

function withEnv(env, fn) {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('line picks one fixed line under 80 chars, or none', () => withEnv({ BUC_OFF: '', BUC_NOW: '1700000000000' }, () => {
  for (const l of [orch.SOLO, orch.SIZED, orch.NOT_OPTIN, orch.MIDTURN]) assert.ok(l.length < 80, l);
  assert.strictEqual(orch.line('fix the typo in the footer'), '');
  assert.strictEqual(orch.line('ultracode fix the typo in the footer'), orch.SOLO);
  assert.strictEqual(orch.line('ultracode migrate every route to the new router'), orch.SIZED);
  assert.strictEqual(orch.line('what does the ultracode keyword do'), orch.NOT_OPTIN);
  const running = { agents: 3, agentAt: 1700000000000 - 60000 };
  assert.strictEqual(orch.line('also skip the tests folder', { turn: running }), orch.MIDTURN);
  assert.strictEqual(orch.line('also skip the tests folder', { turn: { agents: 3, agentAt: 1700000000000 - 31 * 60000 } }), '');
  assert.strictEqual(orch.line('also skip the tests folder', { turn: { toolCalls: 9 } }), '');
}));

test('line honours the midturn, keyword and solo BUC_OFF names', () => withEnv({ BUC_OFF: 'midturn,keyword,solo', BUC_NOW: '1700000000000' }, () => {
  assert.strictEqual(orch.line('go on', { turn: { agents: 1, agentAt: 1700000000000 } }), '');
  assert.strictEqual(orch.line('what is ultracode'), '');
  assert.strictEqual(orch.line('ultracode fix the typo'), '');
}));

test('the prompt hook adds the orchestration line inside the caps and keeps the self line whole', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const store = require('../lib/rules/store');
  const inject = require('../hooks/inject');
  const { SELF_SHORT } = require('../lib/intent');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-orch-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-orch-cwd-'));
  withEnv({ BUC_HOME: home, BUC_OFF: '', BUC_NOW: '1700000000000' }, () => {
    const ctx = (prompt, session = 'o') => {
      const out = inject.run({ prompt, cwd, session_id: session, transcript_path: '' });
      return out ? out.hookSpecificOutput.additionalContext : '';
    };
    const solo = ctx('ultracode fix the typo in the footer');
    assert.ok(solo.endsWith(orch.SOLO), solo);
    assert.ok(solo.includes(SELF_SHORT), 'the self line still fits');
    assert.ok(solo.length <= 500);
    assert.ok(ctx('explain what the ultracode keyword does').includes(orch.NOT_OPTIN));
    assert.ok(!ctx('fix the typo in the footer').includes('agents'));
    store.patchTurn('mid', { agents: 2, agentAt: 1700000000000 - 5000 });
    assert.ok(ctx('also leave the tests alone', 'mid').includes(orch.MIDTURN));
  });
});
