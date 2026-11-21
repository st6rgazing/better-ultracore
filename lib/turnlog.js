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

module.exports = { failed, text };
