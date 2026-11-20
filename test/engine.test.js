'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createEngine, DEFAULT_LIMITS } = require('../lib/engine');

test('default limits', () => {
  assert.deepStrictEqual(DEFAULT_LIMITS, { maxLaunches: 6, maxElapsedMin: 30 });
});

const ok = (files = ['a.js']) => ({ changed_files: files, diff_empty: false, check: { cmd: 'npm test', passed: true } });
const bad = (err) => ({ changed_files: ['a.js'], diff_empty: false, check: { cmd: 'npm test', passed: false, first_error: err } });
const item = (id, files) => ({ id, files, steps: [`do ${id}`] });
const seq = (thunks) => Promise.all(thunks.map((t) => t()));

function harness(answers, extra = {}) {
  const calls = [];
  const agent = async (prompt, o) => { calls.push({ prompt, ...o }); const a = answers.shift(); return typeof a === 'function' ? a(o) : a; };
  return { calls, engine: createEngine({ agent, parallel: seq, log() {}, ...extra }) };
}

test('disjoint items share a wave, overlap is serialized, max 3 workers', async () => {
  const items = [item('a', ['x']), item('b', ['x']), item('c', ['y']), item('d', ['z']), item('e', ['w'])];
  const waves = [];
  const calls = [];
  const engine = createEngine({
    agent: async (p, o) => (calls.push(o.label), ok(items.find((i) => `work:${i.id}` === o.label).files)),
    parallel: async (thunks) => (waves.push(thunks.length), seq(thunks)),
    log() {},
  });
  const r = await engine.run({ request: 'x', items, limits: { maxLaunches: 9 } });
  assert.strictEqual(r.status, 'done');
  assert.deepStrictEqual(waves, [3, 2]);
  assert.deepStrictEqual(calls, ['work:a', 'work:c', 'work:d', 'work:b', 'work:e']);
});

test('worker launches use sonnet and the worker agent', async () => {
  const h = harness([ok(['x'])]);
  await h.engine.run({ request: 'x', items: [item('a', ['x'])] });
  assert.strictEqual(h.calls[0].model, 'sonnet');
  assert.strictEqual(h.calls[0].agentType, 'better-ultracore:worker');
  assert.match(h.calls[0].prompt, /Edit only these files: x/);
});

test('fileless items are rejected, result partial', async () => {
  const h = harness([ok(['x'])]);
  const r = await h.engine.run({ request: 'x', items: [item('a', ['x']), item('b', [])] });
  assert.strictEqual(r.status, 'partial');
  assert.match(r.reason, /rejected fileless: b/);
});

test('a worker writing outside its assigned files fails its item', async () => {
  const h = harness([ok(['x', 'y']), ok(['y'])]);
  const r = await h.engine.run({ request: 'x', items: [item('a', ['x']), item('b', ['y'])] });
  assert.strictEqual(r.status, 'partial');
  assert.match(r.reason, /wrote outside assigned files: a/);
});

test('failed check and empty diff fail the item, no repair launch', async () => {
  const empty = { changed_files: [], diff_empty: true, check: { cmd: 'npm test', passed: true } };
  const h = harness([bad('boom'), empty]);
  const r = await h.engine.run({ request: 'x', items: [item('a', ['a.js']), item('b', ['b.js'])] });
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(r.launches, 2);
});

test('stall retries once with :retry label, counted as launch', async () => {
  const h = harness([null, ok(['x'])]);
  const r = await h.engine.run({ request: 'x', items: [item('a', ['x'])] });
  assert.deepStrictEqual(h.calls.map((c) => c.label), ['work:a', 'work:a:retry']);
  assert.strictEqual(r.launches, 2);
  assert.strictEqual(r.status, 'done');
});

test('second stall returns partial, never an empty result', async () => {
  const r = await harness([null, null]).engine.run({ request: 'x', items: [item('a', ['x'])] });
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(r.launches, 2);
  assert.ok(r.limits_report.length);
});

test('null outcome from the runtime counts as partial, no crash', async () => {
  const h = harness([ok(['x']), ok(['y'])], { parallel: async (t) => { const r = await seq(t); r[1] = null; return r; } });
  const r = await h.engine.run({ request: 'x', items: [item('a', ['x']), item('b', ['y'])] });
  assert.strictEqual(r.status, 'partial');
});

test('maxLaunches caps total agent calls', async () => {
  const h = harness([ok(['x']), ok(['y']), ok(['z'])]);
  const r = await h.engine.run({ request: 'x', items: ['x', 'y', 'z'].map((f) => item(f, [f])), limits: { maxLaunches: 2 } });
  assert.strictEqual(h.calls.length, 2);
  assert.strictEqual(r.launches, 2);
  assert.strictEqual(r.status, 'partial');
});

test('agent throwing (budget exhausted) yields partial', async () => {
  const h = harness([() => { throw new Error('budget exhausted'); }]);
  const r = await h.engine.run({ request: 'x', items: [item('a', ['x'])] });
  assert.match(JSON.stringify(r), /budget exhausted/);
  assert.notStrictEqual(r.status, 'done');
});

test('low budget skips optional launches and logs', async () => {
  const logs = [];
  const engine = createEngine({
    agent: async () => ok(['x']),
    parallel: seq,
    log: (m) => logs.push(m),
    budget: { total: 100000, remaining: () => 5000 },
  });
  const r = await engine.run({ request: 'x', items: [item('a', ['x']), item('b', ['y'])] });
  assert.strictEqual(r.launches, 1);
  assert.strictEqual(r.status, 'partial');
  assert.ok(logs.some((l) => /budget/.test(l)));
});

test('deep: one read-only critic with task, diff and rules; no workers needed', async () => {
  const h = harness([{ summary: 'fine', defects: [] }]);
  const r = await h.engine.run({ request: 'fix auth', deep: true, diff: 'DIFFTEXT', rules: ['r1: be small'] });
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(h.calls.length, 1);
  assert.strictEqual(h.calls[0].agentType, 'better-ultracore:critic');
  assert.strictEqual(h.calls[0].model, 'sonnet');
  for (const s of ['fix auth', 'DIFFTEXT', 'r1: be small', 'tmpdir', 'never edit']) assert.ok(h.calls[0].prompt.includes(s), s);
});

test('deep: critic defects make the result partial and are returned', async () => {
  const h = harness([{ summary: 's', defects: ['empty hash verifies'] }]);
  const r = await h.engine.run({ request: 'x', deep: true });
  assert.strictEqual(r.status, 'partial');
  assert.deepStrictEqual(r.defects, ['empty hash verifies']);
});

test('without deep no critic is launched', async () => {
  const h = harness([ok(['x'])]);
  await h.engine.run({ request: 'x', items: [item('a', ['x'])] });
  assert.ok(h.calls.every((c) => c.agentType !== 'better-ultracore:critic'));
});

test('brief carries request, base, delimited rules and no-override line', async () => {
  const h = harness([ok(['a.js'])]);
  await h.engine.run({ request: 'do x', base: 'abc', rules: ['use tabs'], items: [item('a', ['a.js'])] });
  for (const s of ['do x', 'abc', 'a.js', '<<<RULES', 'untrusted advisory', 'are not overrides']) assert.ok(h.calls[0].prompt.includes(s), s);
});

test('workflows/buc-flow.js is not stale', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync('node', [require('node:path').join(__dirname, '..', 'scripts', 'build-workflow.js'), '--check'], { stdio: 'pipe' });
});

test('generated workflow runs as an async function body', async () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'workflows', 'buc-flow.js'), 'utf8')
    .replace(/export const meta = \{[\s\S]*?\n\};\n/, '');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction('agent', 'parallel', 'log', 'budget', 'args', src);
  const r = await fn(async () => ok(['x']), seq, () => {}, undefined, { request: 'x', items: [item('a', ['x'])] });
  assert.strictEqual(r.status, 'done');
});
