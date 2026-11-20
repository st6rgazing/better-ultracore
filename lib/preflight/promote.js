'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeManifest(manifestPath, { sha, artifact }) {
  const manifest = { sha, artifact_sha256: sha256File(artifact) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

async function readVersion(url) {
  if (!/^https?:/.test(url)) return JSON.parse(fs.readFileSync(url, 'utf8'));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Compares the manifest with the local artifact and/or the deployed /__version.
async function verify(manifestPath, { artifact, url }) {
  const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const problems = [];
  if (artifact && sha256File(artifact) !== expected.artifact_sha256) problems.push('artifact checksum mismatch');
  if (url) {
    try {
      const live = await readVersion(url);
      if (live.sha !== expected.sha) problems.push('deployed sha mismatch');
      if (live.artifact_sha256 && live.artifact_sha256 !== expected.artifact_sha256) problems.push('deployed checksum mismatch');
    } catch (e) {
      return { status: 'unverified', detail: `cannot read ${url}: ${e.message}` };
    }
  }
  if (!artifact && !url) return { status: 'unverified', detail: 'nothing to verify against' };
  return problems.length ? { status: 'failed', detail: problems.join('; ') } : { status: 'passed', detail: 'matches manifest' };
}

module.exports = { sha256File, writeManifest, verify };
