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
