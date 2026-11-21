'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const budget = require('../lib/budget');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'buc-budget-')));
function conf(value) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'buc.json'), JSON.stringify({ agentBudget: value }));
  return dir;
}

test('agentBudget scales the cap with the turn and reads agentBudget from buc.json', () => {
  const dir = tmp();
  assert.deepStrictEqual(budget.agentBudget({ intent: 'SELF' }, dir), { cap: 6, ceiling: 16 });
  assert.deepStrictEqual(budget.agentBudget({}, dir), { cap: 6, ceiling: 16 });
  assert.deepStrictEqual(budget.agentBudget({ intent: 'EXACT' }, dir), { cap: 2, ceiling: 16 });
  assert.strictEqual(budget.agentBudget({ intent: 'SELF' }, conf(false)), null);
  assert.deepStrictEqual(budget.agentBudget({ intent: 'SELF' }, conf(4)), { cap: 4, ceiling: 16 });
  assert.deepStrictEqual(budget.agentBudget({ intent: 'UNDO' }, conf({ small: 1, large: 9, ceiling: 12 })), { cap: 1, ceiling: 12 });
  assert.deepStrictEqual(budget.agentBudget({ intent: 'SELF' }, conf({ large: 30 })), { cap: 30, ceiling: 30 });
});

const agent = (tool_input = {}, tool_response = 'report') => ({ tool_name: 'Agent', tool_input, tool_response });

test('limitError needs an error-shaped response, not a report that mentions limits', () => {
  assert.strictEqual(budget.limitError(agent({}, 'You have hit your limit. Resets at 5pm.')), true);
  assert.strictEqual(budget.limitError(agent({}, { is_error: true, content: [{ type: 'text', text: 'Credit balance is too low' }] })), true);
  assert.strictEqual(budget.limitError(agent({}, { status: 'failed', error: 'usage limit reached for this account' })), true);
  assert.strictEqual(budget.limitError(agent({}, `The handler returns 429 when the usage limit is passed. ${'x'.repeat(700)}`)), false);
  assert.strictEqual(budget.limitError(agent({}, 'All three files updated.')), false);
  assert.strictEqual(budget.limitError(agent({}, undefined)), false);
});

test('promptKey is the same for the same brief and differs by brief, agent type and tool', () => {
  const a = budget.promptKey(agent({ prompt: 'Find every caller of  parse()\n' }));
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.strictEqual(budget.promptKey(agent({ prompt: 'find every caller of parse()' })), a);
  assert.notStrictEqual(budget.promptKey(agent({ prompt: 'find every caller of render()' })), a);
  assert.notStrictEqual(budget.promptKey(agent({ prompt: 'find every caller of parse()', subagent_type: 'Explore' })), a);
  assert.notStrictEqual(budget.promptKey({ tool_name: 'Workflow', tool_input: { script: 'find every caller of parse()' } }), a);
  assert.strictEqual(budget.promptKey(agent({})), '');
});

test('needsModel flags a default-model launch and leaves typed agents, forks and named workflows alone', () => {
  assert.strictEqual(budget.needsModel(agent({ prompt: 'x' })), true);
  assert.strictEqual(budget.needsModel(agent({ prompt: 'x', subagent_type: 'general-purpose' })), true);
  assert.strictEqual(budget.needsModel(agent({ prompt: 'x', model: 'haiku' })), false);
  assert.strictEqual(budget.needsModel(agent({ prompt: 'x', subagent_type: 'Explore' })), false);
  assert.strictEqual(budget.needsModel(agent({ prompt: 'x', subagent_type: 'fork' })), false);
  assert.strictEqual(budget.needsModel({ tool_name: 'Workflow', tool_input: { script: 'await agent({prompt})' } }), true);
  assert.strictEqual(budget.needsModel({ tool_name: 'Workflow', tool_input: { script: 'await agent({prompt, model: "haiku"})' } }), false);
  assert.strictEqual(budget.needsModel({ tool_name: 'Workflow', tool_input: { name: 'buc-flow' } }), false);
});

const many = (n, input = (i) => ({ prompt: `part ${i}`, model: 'haiku' })) => Array.from({ length: n }, (_, i) => agent(input(i)));
function withOff(off, fn) {
  const old = process.env.BUC_OFF;
  process.env.BUC_OFF = off;
  try { return fn(); } finally { if (old === undefined) delete process.env.BUC_OFF; else process.env.BUC_OFF = old; }
}

test('inspect counts launches, warns once above the cap and stops at the ceiling', () => withOff('', () => {
  const dir = tmp();
  assert.deepStrictEqual(budget.inspect({}, [{ tool_name: 'Read', tool_input: {} }], dir), { patch: {}, notes: [], stop: '' });
  const first = budget.inspect({ intent: 'SELF' }, many(6), dir);
  assert.deepStrictEqual([first.patch.agents, first.notes, first.stop], [6, [], '']);
  const over = budget.inspect({ intent: 'SELF', agents: 6 }, many(1), dir);
  assert.match(over.notes[0], /^Agents: 7 launched on one request/);
  assert.deepStrictEqual(budget.inspect({ intent: 'SELF', agents: 7 }, many(1), dir).notes, [], 'only once');
  assert.match(budget.inspect({ intent: 'EXACT', agents: 2 }, many(1), dir).notes[0], /3 launched on a small request/);
  const stop = budget.inspect({ intent: 'SELF', agents: 14 }, many(3), dir);
  assert.match(stop.stop, /17 agents launched this turn, the ceiling is 16/);
  assert.strictEqual(stop.patch.agents, 17);
  assert.strictEqual(budget.inspect({ agents: 17 }, many(1), dir).stop, '', 'the ceiling stops once');
  assert.strictEqual(budget.inspect({ agents: 15 }, many(5), conf(false)).stop, '');
}));

test('inspect stops on a limit error and on a third identical brief, and notes a missing model once', () => withOff('', () => {
  const dir = tmp();
  assert.match(budget.inspect({}, [agent({ prompt: 'a', model: 'haiku' }, 'You have hit your limit.')], dir).stop, /usage or account limit/);
  const same = () => agent({ prompt: 'look at the parser', model: 'haiku' });
  const two = budget.inspect({}, [same(), same()], dir);
  assert.strictEqual(two.stop, '');
  assert.match(budget.inspect({ ...two.patch }, [same()], dir).stop, /same agent brief was dispatched 3 times/);
  const noted = budget.inspect({}, [agent({ prompt: 'a' })], dir);
  assert.match(noted.notes[0], /without a model/);
  assert.strictEqual(noted.patch.modelNoted, true);
  assert.deepStrictEqual(budget.inspect({ ...noted.patch }, [agent({ prompt: 'b' })], dir).notes, []);
}));

test('inspect honours each BUC_OFF name', () => {
  const dir = tmp();
  withOff('agents,agent-limit,agent-repeat,agent-model', () => {
    const r = budget.inspect({ agents: 15 }, [agent({ prompt: 'a' }, 'You have hit your limit.'), agent({ prompt: 'a' }), agent({ prompt: 'a' })], dir);
    assert.deepStrictEqual([r.notes, r.stop, r.patch.agents], [[], '', 18]);
  });
});

test('the tool hook adds agent notes to its context and exits 2 with the reason on a hard stop', () => {
  const { spawnSync } = require('node:child_process');
  const store = require('../lib/rules/store');
  const home = tmp();
  const dir = tmp();
  const hook = (input) => spawnSync('node', [path.join(__dirname, '..', 'hooks', 'track.js')], { input: JSON.stringify({ session_id: 'a', cwd: dir, hook_event_name: 'PostToolBatch', ...input }), encoding: 'utf8', env: { ...process.env, BUC_HOME: home, BUC_OFF: '' } });
  const note = hook({ tool_calls: [agent({ prompt: 'one' })] });
  assert.strictEqual(note.status, 0);
  const out = JSON.parse(note.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolBatch');
  assert.match(out.hookSpecificOutput.additionalContext, /without a model/);
  const quiet = hook({ tool_calls: [agent({ prompt: 'two', model: 'haiku' })] });
  assert.deepStrictEqual([quiet.status, quiet.stdout], [0, '']);
  const stop = hook({ tool_calls: [agent({ prompt: 'three', model: 'haiku' }, 'You have hit your limit.')] });
  assert.strictEqual(stop.status, 2);
  assert.match(stop.stderr, /usage or account limit/);
  assert.strictEqual(stop.stdout, '');
  const old = process.env.BUC_HOME;
  process.env.BUC_HOME = home;
  try { assert.deepStrictEqual([store.readTurn('a').agents, store.readTurn('a').toolCalls], [3, 3]); } finally { if (old === undefined) delete process.env.BUC_HOME; else process.env.BUC_HOME = old; }
  const sub = hook({ agent_id: 'x', tool_calls: [agent({ prompt: 'four' }, 'You have hit your limit.')] });
  assert.deepStrictEqual([sub.status, sub.stdout], [0, ''], 'a subagent is never stopped or counted');
});
