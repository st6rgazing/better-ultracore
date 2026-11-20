'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function homeDir() {
  return process.env.BUC_HOME || path.join(os.homedir(), '.claude', 'better-ultracore');
}

function dirFor(repoRoot) {
  return repoRoot ? path.join(repoRoot, '.claude') : homeDir();
}

function filesFor(repoRoot) {
  const dir = dirFor(repoRoot);
  return repoRoot
    ? { prefs: path.join(dir, 'buc-prefs.json'), tombstones: path.join(dir, 'buc-tombstones.json') }
    : { prefs: path.join(dir, 'prefs.json'), tombstones: path.join(dir, 'tombstones.json') };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

module.exports = { homeDir, filesFor, readJson, writeJson };
