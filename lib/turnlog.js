'use strict';
// The turn's tool log: what hooks/track.js keeps in the turn file so the Stop hook can tell what was run.
// Only sequence numbers and outcomes are stored, never a command or its output.

const text = (resp) => {
  if (typeof resp === 'string') return resp;
  if (!resp || typeof resp !== 'object') return '';
  if (Array.isArray(resp)) return resp.map(text).join('\n');
  return ['stdout', 'stderr', 'output', 'content', 'text', 'error', 'message', 'result'].map((k) => text(resp[k])).filter(Boolean).join('\n');
};

const FAIL_TEXT = /^Exit code [1-9]\d*\b|^# fail [1-9]|^ℹ fail [1-9]|\b[1-9]\d* (failed|failing)\b|\bFAILED\b|npm ERR! Test failed|^FAIL\b/m;

// true when a tool response shows a failed command, false when it shows none. Reads the common shapes:
// {is_error}, {exit_code | exitCode | returncode}, {interrupted}, and the text of a failed run.
function failed(resp) {
  if (resp && typeof resp === 'object' && !Array.isArray(resp)) {
    if (resp.is_error === true || resp.isError === true || resp.interrupted === true) return true;
    for (const k of ['exit_code', 'exitCode', 'returncode', 'code']) if (Number.isFinite(resp[k]) && resp[k] !== 0) return true;
  }
  return FAIL_TEXT.test(text(resp));
}

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const AGENT_TOOLS = ['Agent', 'Task', 'Workflow'];
const TEST_CMD = /\b(npm (run )?(test|t)\b|(yarn|pnpm|bun|deno) (run )?test\b|node (\S+ )*--test\b|npx (jest|vitest|mocha|playwright)\b|\b(jest|vitest|mocha|pytest|rspec|phpunit|tox|ctest)\b|python\d? -m (pytest|unittest)|go test\b|cargo test\b|make (test|check)\b|(gradlew?|mvn) (\S+ )*test\b|playwright test\b)/;
// Commands that only read: they prove nothing was executed.
const READ_ONLY = /^\s*(cat|ls|head|tail|grep|rg|find|wc|pwd|echo|cd|which|git (status|diff|log|show|branch|grep|blame))\b/;

// What a tool call is for the log: 'edit', 'test' (a test command), 'run' (any other executing command), 'agent' or ''.
function kindOf(call) {
  const name = call && call.tool_name;
  if (EDIT_TOOLS.includes(name)) return 'edit';
  if (AGENT_TOOLS.includes(name)) return 'agent';
  if (name !== 'Bash') return '';
  const cmd = String((call.tool_input || {}).command || '');
  if (TEST_CMD.test(cmd)) return 'test';
  return cmd.split(/&&|\|\||;|\n/).every((part) => !part.trim() || READ_ONLY.test(part)) ? '' : 'run';
}

// Turn-file fields for a batch of tool calls, numbered from the turn's call count before the batch:
//   lastEditAt  number   call number of the last file edit
//   lastRunAt   number   call number of the last executing command (a test run counts)
//   lastTestAt  number   call number of the last test command
//   lastTestOk  boolean  false when that test command's response shows a failure
// Returns only the fields this batch changes.
function record(turn, calls) {
  const before = Number(turn && turn.toolCalls) || 0;
  const patch = {};
  calls.forEach((call, i) => {
    const kind = kindOf(call);
    const at = before + i + 1;
    if (kind === 'edit') patch.lastEditAt = at;
    if (kind === 'run' || kind === 'test') patch.lastRunAt = at;
    if (kind === 'test') Object.assign(patch, { lastTestAt: at, lastTestOk: !failed(call.tool_response) });
  });
  return patch;
}

module.exports = { failed, text, kindOf, record, AGENT_TOOLS };
