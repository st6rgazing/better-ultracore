'use strict';
const test = require('node:test');
const assert = require('node:assert');
const log = require('../lib/turnlog');

test('failed reads exit codes, error flags and failing test summaries', () => {
  assert.strictEqual(log.failed({ stdout: 'ok', exit_code: 0 }), false);
  assert.strictEqual(log.failed({ stdout: '', exitCode: 1 }), true);
  assert.strictEqual(log.failed({ is_error: true }), true);
  assert.strictEqual(log.failed('Exit code 1\nboom'), true);
  assert.strictEqual(log.failed({ stdout: '# tests 4\n# pass 3\n# fail 1' }), true);
  assert.strictEqual(log.failed({ stdout: '# tests 4\n# pass 4\n# fail 0' }), false);
  assert.strictEqual(log.failed({ stdout: '2 failed, 10 passed' }), true);
  assert.strictEqual(log.failed('0 failed, 10 passed'), false);
  assert.strictEqual(log.failed(undefined), false);
  assert.strictEqual(log.failed([{ type: 'text', text: 'FAILED tests/test_a.py::test_x' }]), true);
});

const bash = (command, tool_response) => ({ tool_name: 'Bash', tool_input: { command }, tool_response });

test('kindOf tells edits, test commands, other runs, agents and read-only commands apart', () => {
  assert.strictEqual(log.kindOf({ tool_name: 'Edit', tool_input: {} }), 'edit');
  assert.strictEqual(log.kindOf({ tool_name: 'Write', tool_input: {} }), 'edit');
  assert.strictEqual(log.kindOf({ tool_name: 'Agent', tool_input: {} }), 'agent');
  assert.strictEqual(log.kindOf({ tool_name: 'Workflow', tool_input: {} }), 'agent');
  assert.strictEqual(log.kindOf({ tool_name: 'Read', tool_input: {} }), '');
  for (const c of ['npm test', 'npm run test -- --watch=false', 'node --test test/', 'cd api && pytest -q', 'go test ./...', 'npx vitest run', 'cargo test', 'python -m pytest']) {
    assert.strictEqual(log.kindOf(bash(c)), 'test', c);
  }
  for (const c of ['node script.js', 'curl -s localhost:3000', 'ls && node build.js']) assert.strictEqual(log.kindOf(bash(c)), 'run', c);
  for (const c of ['cat a.js', 'git status', 'ls -la && git diff', 'grep -rn foo src']) assert.strictEqual(log.kindOf(bash(c)), '', c);
});

test('record numbers the calls of a batch and keeps the last edit, run and test', () => {
  const calls = [{ tool_name: 'Read', tool_input: {} }, { tool_name: 'Edit', tool_input: {} }, bash('npm test', 'Exit code 1\n# fail 2'), bash('node x.js', { stdout: 'ok' })];
  assert.deepStrictEqual(log.record({ toolCalls: 10 }, calls), { lastEditAt: 12, lastRunAt: 14, lastTestAt: 13, lastTestOk: false });
  assert.deepStrictEqual(log.record({}, [bash('npm test', { stdout: '# fail 0' })]), { lastRunAt: 1, lastTestAt: 1, lastTestOk: true });
  assert.deepStrictEqual(log.record({ toolCalls: 3 }, [{ tool_name: 'Grep', tool_input: {} }]), {});
});
