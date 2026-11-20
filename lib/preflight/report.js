'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

function write(outDir, checks) {
  fs.mkdirSync(outDir, { recursive: true });
  const report = { exitCode: exitCode(checks), checks };
  fs.writeFileSync(path.join(outDir, 'preflight.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'preflight.md'), toMarkdown(checks));
  return report;
}

module.exports = { STATUS, check, exitCode, toMarkdown, write };
