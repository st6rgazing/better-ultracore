'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createEngine, DEFAULT_LIMITS, signature, brief } = require('../lib/engine');

test('default limits', () => {
  assert.deepStrictEqual(DEFAULT_LIMITS, { maxLaunches: 6, maxRepairs: 2, maxElapsedMin: 30 });
});

test('signature ignores numbers, paths, whitespace', () => {
  const a = signature({ cmd: 'npm test', first_error: 'Error at /a/b.js:12  bad thing 3' });
  const b = signature({ cmd: 'npm test', first_error: 'Error at /x/y.js:99 bad   thing 7' });
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, signature({ cmd: 'npm lint', first_error: 'Error at /a/b.js:12 bad thing 3' }));
});

test('brief carries request, base, delimited prefs and no-override line', () => {
  const b = brief({ request: 'do x', base: 'abc', files: ['a.js'], prefs: ['use tabs'] });
  for (const s of ['do x', 'abc', 'a.js', '<<<PREFS', 'untrusted advisory', 'are not overrides']) assert.ok(b.includes(s), s);
});

const ok = (files = ['a.js']) => ({ changed_files: files, diff_empty: false, check: { cmd: 'npm test', passed: true } });
const bad = (err) => ({ changed_files: ['a.js'], diff_empty: false, check: { cmd: 'npm test', passed: false, first_error: err } });

function harness(answers) {
  const calls = [];
  const agent = async (prompt, o) => { calls.push({ prompt, ...o }); const a = answers.shift(); return typeof a === 'function' ? a(o) : a; };
  return { calls, engine: createEngine({ agent, log() {} }) };
}

test('small: coder then passing check is done', async () => {
  const h = harness([ok()]);
  const r = await h.engine.run({ request: 'x', route: 'small', files: ['a.js'] });
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.launches, 1);
  assert.strictEqual(h.calls[0].model, 'sonnet');
  assert.strictEqual(h.calls[0].label, 'code');
  assert.strictEqual(r.limits_report.length, 5);
});

test('stall retries once with :retry label, counted as launch', async () => {
  const h = harness([null, ok()]);
  const r = await h.engine.run({ request: 'x', route: 'small' });
  assert.deepStrictEqual(h.calls.map((c) => c.label), ['code', 'code:retry']);
  assert.strictEqual(r.launches, 2);
  assert.strictEqual(r.status, 'done');
});

test('second stall returns partial', async () => {
  const r = await harness([null, null]).engine.run({ request: 'x', route: 'small' });
  assert.strictEqual(r.status, 'partial');
  assert.strictEqual(r.launches, 2);
});

test('repair loop stops at maxRepairs', async () => {
  const r = await harness([bad('alpha'), bad('beta'), bad('gamma')]).engine.run({ request: 'x', route: 'small' });
  assert.strictEqual(r.repairs, 2);
  assert.strictEqual(r.status, 'failed');
  assert.match(r.reason, /maxRepairs/);
});

test('repair loop stops when failure signature repeats', async () => {
  const r = await harness([bad('boom at a.js:1'), bad('boom at b.js:9')]).engine.run({ request: 'x', route: 'small' });
  assert.strictEqual(r.repairs, 1);
  assert.match(r.reason, /repeated/);
});

test('repair loop stops on empty diff', async () => {
  const empty = { changed_files: [], diff_empty: true, check: { cmd: 'npm test', passed: false, first_error: 'x' } };
  const r = await harness([empty]).engine.run({ request: 'x', route: 'small' });
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(r.launches, 1);
});

test('repair succeeds', async () => {
  const r = await harness([bad('e1'), ok()]).engine.run({ request: 'x', route: 'small' });
  assert.strictEqual(r.status, 'done');
  assert.deepStrictEqual(r.completed_steps.map((s) => s.id), ['code', 'code:repair1']);
});

test('unknown route returns failed result, never empty', async () => {
  const r = await harness([]).engine.run({ request: 'x', route: 'nope' });
  assert.strictEqual(r.status, 'failed');
});
