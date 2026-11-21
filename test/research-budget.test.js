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
