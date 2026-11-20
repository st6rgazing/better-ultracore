'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runBuild(dir, cmd = 'npm run build') {
  const r = spawnSync(cmd, { cwd: dir, shell: true, stdio: 'ignore' });
  return r.status === 0
    ? { status: 'passed', detail: `${cmd} exited 0` }
    : { status: 'failed', detail: `${cmd} exited ${r.status ?? r.signal}` };
}

module.exports = { runBuild };
