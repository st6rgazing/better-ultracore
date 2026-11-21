'use strict';
const test = require('node:test');
const assert = require('node:assert');
const levers = require('../bench/levers');
const orchestrate = require('../lib/orchestrate');
const { SELF } = require('../lib/intent');
const { render } = require('../lib/rules/retrieve');
const { probeLine } = require('../lib/probe');

test('leversOf splits injected text into chars per lever', () => {
  const rules = render([{ rule: 'Use icons, not emoji.', check: {} }, { rule: 'Keep commits small.', check: {} }]);
  const prompt = 'ultracode fix the token parser';
  const probe = probeLine(prompt);
  assert.ok(probe);
  const text = [rules, 'Check command: npm test', 'The typecheck runs automatically when you finish; do not run it yourself.', SELF, probe, orchestrate.SOLO].join('\n');
  const got = levers.leversOf(text, prompt);
  assert.deepStrictEqual(Object.keys(got).sort(), ['check', 'intent', 'orchestrate', 'probe', 'rules', 'typecheck']);
  assert.strictEqual(got.rules, rules.length + 1);
  assert.strictEqual(got.intent, SELF.length + 1);
  assert.strictEqual(got.orchestrate, orchestrate.SOLO.length + 1);
  assert.strictEqual(Object.values(got).reduce((a, b) => a + b, 0), text.length + 1);
  assert.deepStrictEqual(levers.leversOf(''), {});
});

test('tally and leverMetrics give corrections addressed per 1k injected tokens for each lever', () => {
  const totals = {};
  levers.tally(totals, { rules: 400, intent: 420 });
  levers.tally(totals, { intent: 380, orchestrate: 80 });
  levers.tally(totals, {});
  assert.deepStrictEqual(totals, { rules: { turns: 1, chars: 400 }, intent: { turns: 2, chars: 800 }, orchestrate: { turns: 1, chars: 80 } });
  const corrections = [
    { levers: { rules: 400, intent: 420 }, pattern: 'misread', covered: [{ id: 'r' }] },
    { levers: { intent: 380, orchestrate: 80 }, pattern: 'still', covered: [] },
    { levers: {}, pattern: 'misread', covered: [] },
  ];
  const m = levers.leverMetrics({ levers: totals, corrections });
  assert.deepStrictEqual(m.rules, { turns: 1, tokens: 100, followed: 1, addressed: 1, per_1k: 10 });
  assert.deepStrictEqual(m.intent, { turns: 2, tokens: 200, followed: 2, addressed: 1, per_1k: 5 });
  assert.deepStrictEqual(m.orchestrate, { turns: 1, tokens: 20, followed: 1, addressed: null, per_1k: null });
  assert.deepStrictEqual(levers.leverMetrics({}), {});
});
