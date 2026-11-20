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

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function checkNoSourceMaps(distDir, allowMaps = false) {
  if (!fs.existsSync(distDir)) return { status: 'unverified', detail: 'dist directory missing' };
  if (allowMaps) return { status: 'passed', detail: 'source maps allowed by config' };
  const maps = [...walk(distDir)].filter(p => p.endsWith('.map')).map(p => path.relative(distDir, p));
  return maps.length
    ? { status: 'failed', detail: `source maps in dist: ${maps.join(', ')}` }
    : { status: 'passed', detail: 'no .map files in dist' };
}

module.exports = { runBuild, checkNoSourceMaps };
