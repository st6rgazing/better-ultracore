'use strict';

const { spawnSync } = require('node:child_process');

function hasPlaywright(dir) {
  try {
    require.resolve('@playwright/test', { paths: [dir] });
    return true;
  } catch {
    return false;
  }
}

function runBrowser(dir, cmd = 'npx playwright test') {
  if (!hasPlaywright(dir)) return { status: 'unverified', detail: '@playwright/test not installed' };
  const r = spawnSync(cmd, { cwd: dir, shell: true, stdio: 'ignore' });
  return r.status === 0
    ? { status: 'passed', detail: `${cmd} exited 0` }
    : { status: 'failed', detail: `${cmd} exited ${r.status ?? r.signal}` };
}

module.exports = { runBrowser };
