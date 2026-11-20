'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createEngine, DEFAULT_LIMITS } = require('../lib/engine');

test('default limits', () => {
  assert.deepStrictEqual(DEFAULT_LIMITS, { maxLaunches: 6, maxRepairs: 2, maxElapsedMin: 30 });
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

const plan = (over = {}) => ({ steps: ['s1'], files: ['a.js'], questions_needing_user: [], acceptance: ['works'], ...over });

test('planned: fable planner then sonnet coder', async () => {
  const h = harness([plan(), ok()]);
  const r = await h.engine.run({ request: 'x', route: 'planned' });
  assert.strictEqual(r.status, 'done');
  assert.deepStrictEqual(h.calls.map((c) => [c.label, c.model]), [['plan', 'fable'], ['code', 'sonnet']]);
  assert.match(h.calls[1].prompt, /Acceptance:\n- works/);
});

test('planned: open questions return needs_user without coding', async () => {
  const h = harness([plan({ questions_needing_user: ['which db?'] })]);
  const r = await h.engine.run({ request: 'x', route: 'planned' });
  assert.strictEqual(r.status, 'needs_user');
  assert.deepStrictEqual(r.questions, ['which db?']);
  assert.strictEqual(h.calls.length, 1);
});

const vok = (over = {}) => ({ ...ok(), defects: [], ...over });

test('guarded: planner, coder, verifier with agentType and git diff base', async () => {
  const h = harness([plan(), ok(), vok()]);
  const r = await h.engine.run({ request: 'x', route: 'guarded', base: 'abc123' });
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(h.calls[2].agentType, 'better-ultracore:verifier');
  assert.match(h.calls[2].prompt, /git diff abc123/);
});

test('guarded: verifier defects give partial', async () => {
  const r = await harness([plan(), ok(), vok({ defects: ['off by one'] })]).engine.run({ request: 'x', route: 'guarded' });
  assert.strictEqual(r.status, 'partial');
  assert.deepStrictEqual(r.defects, ['off by one']);
});

test('guarded: repairs denied before verifier slot is starved', async () => {
  const h = harness([plan(), bad('alpha'), bad('beta'), bad('gamma'), bad('delta')]);
  const r = await h.engine.run({ request: 'x', route: 'guarded', limits: { maxLaunches: 3 } });
  assert.strictEqual(r.launches, 2);
  assert.match(r.reason, /maxLaunches/);
});

test('guarded: verifier still runs when launches are otherwise used up', async () => {
  const h = harness([plan(), ok(), vok()]);
  const r = await h.engine.run({ request: 'x', route: 'guarded', limits: { maxLaunches: 3 } });
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.launches, 3);
});

test('review: reviewer-ro only, no coder', async () => {
  const h = harness([{ summary: 'fine', findings: [] }]);
  const r = await h.engine.run({ request: 'review x', route: 'review' });
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(h.calls.length, 1);
  assert.strictEqual(h.calls[0].agentType, 'better-ultracore:reviewer-ro');
  assert.strictEqual(r.last_check, null);
});

test('brief carries request, base, delimited prefs and no-override line', async () => {
  const h = harness([ok()]);
  await h.engine.run({ request: 'do x', route: 'small', base: 'abc', files: ['a.js'], prefs: ['use tabs'] });
  for (const s of ['do x', 'abc', 'a.js', '<<<PREFS', 'untrusted advisory', 'are not overrides']) assert.ok(h.calls[0].prompt.includes(s), s);
});

test('parallel: disjoint items share a wave, overlap is serialized, max 3 workers', async () => {
  const items = ['a:x', 'b:x', 'c:y', 'd:z', 'e:w'].map((s) => ({ id: s[0], files: [s[2]], steps: [] }));
  const calls = [];
  const waves = [];
  const engine = createEngine({
    agent: async (p, o) => (calls.push(o.label), o.label === 'plan' ? plan({ items }) : ok()),
    parallel: async (thunks) => (waves.push(thunks.length), Promise.all(thunks.map((t) => t()))),
    log() {},
  });
  const r = await engine.run({ request: 'x', route: 'parallel', limits: { maxLaunches: 9 } });
  assert.strictEqual(r.status, 'done');
  assert.deepStrictEqual(waves, [3, 2]);
  assert.deepStrictEqual(calls, ['plan', 'work:a', 'work:c', 'work:d', 'work:b', 'work:e']);
});

test('parallel: fileless items are rejected, result partial', async () => {
  const items = [{ id: 'a', files: ['x'], steps: [] }, { id: 'b', files: [], steps: [] }];
  const engine = createEngine({
    agent: async (p, o) => (o.label === 'plan' ? plan({ items }) : ok()),
    parallel: (thunks) => Promise.all(thunks.map((t) => t())),
    log() {},
  });
  const r = await engine.run({ request: 'x', route: 'parallel' });
  assert.strictEqual(r.status, 'partial');
  assert.match(r.reason, /rejected fileless: b/);
});

test('uncertain confidence asks haiku with a schema to choose the route', async () => {
  const h = harness([{ route: 'small' }, ok()]);
  const r = await h.engine.run({ request: 'x', route: 'planned', confidence: 'uncertain' });
  assert.strictEqual(r.route, 'small');
  assert.strictEqual(h.calls[0].model, 'haiku');
  assert.ok(h.calls[0].schema);
  assert.strictEqual(r.launches, 2);
});

test('uncertain with failed chooser falls back to planned', async () => {
  const r = await harness([null, null, plan({ questions_needing_user: ['q'] })]).engine.run({ request: 'x', route: 'small', confidence: 'uncertain' });
  assert.strictEqual(r.route, 'planned');
});
