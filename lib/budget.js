'use strict';
// Orchestration budget: how many Agent and Workflow launches a turn may make. Used by hooks/track.js.
// Source: reports of token burn far beyond task size, of fan-out past the concurrency cap, and of retries repeating work at full cost.
const fs = require('node:fs');
const path = require('node:path');

const SMALL_CAP = 2; // turns with a fixed reading or a correction
const LARGE_CAP = 6; // every other turn; the plugin's own workflow launches at most 6
const CEILING = 16;
const OPEN = ['', 'SELF', 'FEATURE'];
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

// {cap, ceiling}: launches before the notice and before the hard stop; null when switched off.
// "agentBudget" in <root>/.claude/buc.json: false for none, a number for the cap (ceiling stays), or {small, large, ceiling}.
function agentBudget(turn, root) {
  let conf;
  try { conf = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'buc.json'), 'utf8')).agentBudget; } catch { /* no config */ }
  if (conf === false || conf === 0) return null;
  const small = typeof (turn || {}).intent === 'string' && !OPEN.includes(turn.intent);
  const set = conf && typeof conf === 'object' ? conf : {};
  const cap = num(conf) || num(small ? set.small : set.large) || (small ? SMALL_CAP : LARGE_CAP);
  return { cap, ceiling: Math.max(num(set.ceiling) || CEILING, cap) };
}

module.exports = { agentBudget, SMALL_CAP, LARGE_CAP, CEILING };
