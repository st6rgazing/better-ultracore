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

module.exports = { STATUS, check, exitCode };
