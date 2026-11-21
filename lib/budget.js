'use strict';
// Orchestration budget: how many Agent and Workflow launches a turn may make. Used by hooks/track.js.
// Source: reports of token burn far beyond task size, of fan-out past the concurrency cap, and of retries repeating work at full cost.
const fs = require('node:fs');
const path = require('node:path');
const { text, AGENT_TOOLS } = require('./turnlog');
const store = require('./rules/store');

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

const LIMIT = /\b(usage limit|hit your limit|limit reached|rate_limit_error|credit balance is too low|out of (extra )?usage|authentication_error|invalid api key|account (is |has been )?(disabled|suspended))\b/i;
const MAX_ERROR_CHARS = 600;

// True when an agent call came back with a usage-limit or account error. A long successful report that merely
// mentions limits is not one: the response must be flagged as an error or be short.
function limitError(call) {
  const resp = call && call.tool_response;
  const body = text(resp);
  const flagged = Boolean(resp && typeof resp === 'object' && (resp.is_error === true || resp.isError === true || /^(error|failed)$/i.test(String(resp.status || ''))));
  return LIMIT.test(body) && (flagged || body.length <= MAX_ERROR_CHARS);
}

// Hash of what an agent call was asked to do, whitespace and case aside: the same brief sent again gives the same key.
// '' when the call carries no brief. The text is never stored.
function promptKey(call) {
  const input = (call && call.tool_input) || {};
  const brief = typeof input.prompt === 'string' ? input.prompt : typeof input.script === 'string' ? input.script : '';
  const norm = brief.toLowerCase().replace(/\s+/g, ' ').trim();
  return norm ? store.hash(`${call.tool_name}\n${input.subagent_type || ''}\n${norm}`) : '';
}

// Agent types that take the session's model unless the call names one. A named type usually sets its own in its definition.
const INHERITS = ['', 'general-purpose', 'claude'];

// True when an agent launch leaves the model to the default: an Agent call of an inheriting type with no model,
// or an inline Workflow script that never sets one. A fork always runs on the session's model, so it is not flagged.
function needsModel(call) {
  const input = (call && call.tool_input) || {};
  if (call && call.tool_name === 'Workflow') return typeof input.script === 'string' && !/\bmodel\b/.test(input.script);
  return !input.model && INHERITS.includes(String(input.subagent_type || ''));
}

const MAX_SAME = 2; // the same brief may go out twice (one retry); the third stops the turn
const MODEL_NOTE = 'Agent launched without a model: set one on each agent, a small model for search and checks.';
const LIMIT_STOP = 'better-ultracore: an agent hit a usage or account limit. Stopped, so retries do not repeat the work at full cost. Resume when the limit resets.';
const REPEAT_STOP = 'better-ultracore: the same agent brief was dispatched 3 times this turn. Stopped: reuse the earlier result or change the brief.';

// Judges a batch of tool calls against the turn's agent budget. Returns {patch, notes, stop}:
//   patch  turn-file fields to merge: agents (launches this turn), agentAt (time of the last one), agentKeys ({briefHash: count}), modelNoted
//   notes  advisory lines for additionalContext (the cap notice once, the model notice once per turn)
//   stop   a reason to halt the turn (the hook exits 2 with it), or ''
// BUC_OFF names: agents (cap and ceiling), agent-limit, agent-repeat, agent-model.
function inspect(turn, calls, root) {
  const launches = calls.filter((c) => c && AGENT_TOOLS.includes(c.tool_name));
  const out = { patch: {}, notes: [], stop: '' };
  if (!launches.length) return out;
  const on = (name) => !store.off(name, root);
  const before = Number(turn.agents) || 0;
  const after = before + launches.length;
  const keys = { ...(turn.agentKeys || {}) };
  let repeated = false;
  for (const key of launches.map(promptKey).filter(Boolean)) {
    keys[key] = (keys[key] || 0) + 1;
    if (keys[key] === MAX_SAME + 1) repeated = true;
  }
  out.patch = { agents: after, agentAt: store.now(), agentKeys: keys };
  if (on('agent-model') && !turn.modelNoted && launches.some(needsModel)) {
    out.notes.push(MODEL_NOTE);
    out.patch.modelNoted = true;
  }
  const limit = on('agents') ? agentBudget(turn, root) : null;
  const crossed = (n) => before < n && after >= n;
  if (on('agent-limit') && launches.some(limitError)) out.stop = LIMIT_STOP;
  else if (on('agent-repeat') && repeated) out.stop = REPEAT_STOP;
  else if (limit && crossed(limit.ceiling)) {
    out.stop = `better-ultracore: ${after} agents launched this turn, the ceiling is ${limit.ceiling}. Stopped. Raise "agentBudget" in .claude/buc.json or set BUC_OFF=agents to allow more.`;
  } else if (limit && limit.cap < limit.ceiling && crossed(limit.cap + 1)) {
    out.notes.push(`Agents: ${after} launched on ${limit.cap <= SMALL_CAP ? 'a small request' : 'one request'}. Launch no more unless a part cannot be done in this session; finish with what you have.`);
  }
  return out;
}

module.exports = { agentBudget, limitError, promptKey, needsModel, inspect, SMALL_CAP, LARGE_CAP, CEILING };
