'use strict';
// PostToolBatch: count this turn's tool calls in the turn file and say once when a turn passes its budget, once more at twice that.
// Input (hooks reference): {session_id, cwd, hook_event_name, tool_calls: [{tool_name, tool_input, tool_use_id, tool_response}]}.
// A PostToolUse input ({tool_name, tool_input}) counts as one call, so the same script works on either event.
const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/rules/store');

const SMALL = 20; // turns with a fixed reading or a correction
const LARGE = 45; // every other turn
const OPEN = ['', 'SELF', 'FEATURE'];
const SHOT = /\bbuc-shot\b/;

// Tool calls allowed before the notice. "toolBudget" in <root>/.claude/buc.json: a number for every turn, {small, large}, or false for none.
function budget(turn, root) {
  let conf;
  try { conf = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'buc.json'), 'utf8')).toolBudget; } catch { /* no config */ }
  if (conf === false || conf === 0) return 0;
  if (typeof conf === 'number' && conf > 0) return Math.floor(conf);
  const small = typeof turn.intent === 'string' && !OPEN.includes(turn.intent);
  const set = conf && typeof conf === 'object' ? Number(small ? conf.small : conf.large) : 0;
  return set > 0 ? Math.floor(set) : small ? SMALL : LARGE;
}

function run(input) {
  const sessionId = input.session_id;
  // A subagent's calls are its own budget, not the turn's.
  if (!sessionId || input.agent_id) return null;
  const calls = Array.isArray(input.tool_calls) ? input.tool_calls : input.tool_name ? [input] : [];
  if (!calls.length) return null;
  const turn = store.readTurn(sessionId) || {};
  const before = Number(turn.toolCalls) || 0;
  const after = before + calls.length;
  const patch = { toolCalls: after };
  if (calls.some((c) => c && c.tool_name === 'Bash' && SHOT.test(String((c.tool_input || {}).command || '')))) patch.shotAt = store.now();
  store.patchTurn(sessionId, patch);
  const root = turn.root || input.cwd || process.cwd();
  if (store.off('budget', root)) return null;
  const limit = budget(turn, root);
  const crossed = (n) => before < n && after >= n;
  if (!limit || !(crossed(limit) || crossed(limit * 2))) return null;
  const size = limit <= SMALL ? 'a small request' : 'one request';
  return {
    hookSpecificOutput: {
      hookEventName: input.hook_event_name || 'PostToolBatch',
      additionalContext: `Budget: ${after} tool calls on ${size}. Stop exploring, finish the edit you have, report what is unverified.`,
    },
  };
}

module.exports = { run, budget, SMALL, LARGE };

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; }).on('end', () => {
    try {
      const out = run(JSON.parse(raw));
      if (out) console.log(JSON.stringify(out));
    } catch { /* a hook must never break the turn */ }
  });
}
