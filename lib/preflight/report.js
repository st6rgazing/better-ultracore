'use strict';

const STATUS = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  NOT_APPLICABLE: 'not_applicable',
  UNVERIFIED: 'unverified',
});

function check(id, status, detail = '', required = true) {
  return { id, status, required, detail };
}

function exitCode(checks) {
  const bad = c => c.required && (c.status === STATUS.FAILED || c.status === STATUS.UNVERIFIED);
  return checks.some(bad) ? 1 : 0;
}

function toMarkdown(checks) {
  const rows = checks.map(c => `| ${c.id} | ${c.status} | ${c.required ? 'yes' : 'no'} | ${c.detail} |`);
  const verdict = exitCode(checks) ? 'FAIL' : 'PASS';
  return [`# Release preflight: ${verdict}`, '', '| check | status | required | detail |', '|---|---|---|---|', ...rows, ''].join('\n');
}

module.exports = { STATUS, check, exitCode, toMarkdown };
