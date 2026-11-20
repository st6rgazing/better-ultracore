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

module.exports = { sha256File, writeManifest };
