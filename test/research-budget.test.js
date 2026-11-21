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
