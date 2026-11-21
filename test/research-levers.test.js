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
