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

test('replay records the levers shown on each turn and on the request before a correction', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { replay, metrics } = require('../bench/replay');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'buc-levers-')));
  const dir = path.join(root, 'projects', '-Users-x-app');
  fs.mkdirSync(dir, { recursive: true });
  const line = (type, min, content) => JSON.stringify({ type, sessionId: 'l1', timestamp: `2026-05-01T10:${String(min).padStart(2, '0')}:00.000Z`, cwd: '/Users/x/app', message: { role: type, content } });
  fs.writeFileSync(path.join(dir, 'l1.jsonl'), `${[line('user', 0, 'ultracode add icons to the toolbar'), line('assistant', 1, [{ type: 'text', text: 'done' }]), line('user', 5, 'no emoji, use the icon set')].join('\n')}\n`);
  try {
    const sessions = require('../bench/transcripts').allSessions(path.join(root, 'projects'));
    const run = replay(sessions, { home: path.join(root, 'home'), learn: false });
    assert.strictEqual(run.turns, 2);
    assert.strictEqual(run.levers.intent.turns, 2);
    assert.strictEqual(run.levers.orchestrate.turns, 1);
    assert.strictEqual(run.corrections.length, 1);
    assert.deepStrictEqual(Object.keys(run.corrections[0].levers).sort(), ['intent', 'orchestrate']);
    assert.strictEqual(run.corrections[0].pattern, 'misread');
    const m = metrics(run).levers;
    assert.deepStrictEqual([m.intent.followed, m.intent.addressed, m.orchestrate.addressed], [1, 1, null]);
    assert.ok(m.intent.per_1k > 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the replay summary lists each lever with its tokens and corrections per 1k', () => {
  const { summary } = require('../bench/replay');
  const cov = { corrections: 2, recurring: 1, covered: 1, covered_learned: 1, coverage: 0.5 };
  const m = { sessions: 1, turns: 4, cluster_calls: 0, rules: 1, coverage: cov, first_half: cov, second_half: cov, decay_regret: { regretted_rules: 0, archived: 0 }, injection: { turns_with_rules: 1, rule_instances: 1, learned_instances: 1 } };
  const levers = { orchestrate: { turns: 1, tokens: 20, followed: 0, addressed: null, per_1k: null }, intent: { turns: 4, tokens: 400, followed: 2, addressed: 1, per_1k: 2.5 } };
  const text = summary({ learn: { ...m, levers }, no_byrepo: m, no_learn: m, spent_usd: 0 });
  assert.match(text, /Lever intent: 4 turns, 400 tokens, 2 corrections after it, 1 of its kind \(2\.50 per 1k tokens/);
  assert.match(text, /Lever orchestrate: 1 turns, 20 tokens, 0 corrections after it, - of its kind \(- per 1k tokens/);
  assert.ok(text.indexOf('Lever intent') < text.indexOf('Lever orchestrate'), 'the costliest lever first');
  assert.doesNotMatch(summary({ learn: m, no_byrepo: m, no_learn: m, spent_usd: 0 }), /Lever/);
});
