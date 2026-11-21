'use strict';
// Orchestration budget: how many Agent and Workflow launches a turn may make. Used by hooks/track.js.
// Source: reports of token burn far beyond task size, of fan-out past the concurrency cap, and of retries repeating work at full cost.
const fs = require('node:fs');
const path = require('node:path');
const { text } = require('./turnlog');
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

module.exports = { agentBudget, limitError, promptKey, needsModel, SMALL_CAP, LARGE_CAP, CEILING };
