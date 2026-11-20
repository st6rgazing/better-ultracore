'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { evaluate } = require('../lib/preflight/asvs');
const promote = require('../lib/preflight/promote');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'buc-pfg-'));

test('branch protection evidence without required_status_checks fails', () => {
  const dir = tmp();
  const ev = path.join(dir, 'gh-protection.json');
  const run = (obj) => {
    fs.writeFileSync(ev, JSON.stringify(obj));
    return evaluate(dir, [{ id: 'bp', evaluator: 'deployPermissions' }], { evidence: ev })[0];
  };
  const missing = run({ required_pull_request_reviews: {} });
  assert.strictEqual(missing.status, 'failed');
  assert.match(missing.detail, /required status checks/);
  assert.strictEqual(run({ required_pull_request_reviews: {}, required_status_checks: {} }).status, 'passed');
  assert.strictEqual(evaluate(dir, [{ id: 'bp', evaluator: 'deployPermissions' }], {})[0].status, 'unverified');
});

test('promote verify against a local http /__version', async () => {
  const dir = tmp();
  const artifact = path.join(dir, 'dist.tgz');
  fs.writeFileSync(artifact, 'bits');
  const manifest = path.join(dir, 'm.json');
  promote.writeManifest(manifest, { sha: 'abc123', artifact });
  let live = 'abc123';
  const server = http.createServer((req, res) => {
    if (req.url !== '/__version') { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ sha: live }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/__version`;
  try {
    assert.strictEqual((await promote.verify(manifest, { url })).status, 'passed');
    live = 'deadbeef';
    const bad = await promote.verify(manifest, { url });
    assert.strictEqual(bad.status, 'failed');
    assert.match(bad.detail, /deployed sha mismatch/);
  } finally {
    server.close();
  }
});
