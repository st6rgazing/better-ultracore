'use strict';

const test = require('node:test');
const assert = require('node:assert');
const secrets = require('../lib/preflight/secrets');

const FAKE_AWS = 'AKIA' + 'FAKEFAKEFAKEFAKE';

test('secrets: lockfile integrity hashes are not flagged, real keys still are', () => {
  const hash = 'sha512-' + 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ3rS5tU7vW9xY1zA3bC5dE7fG9hI1jQ==';
  assert.strictEqual(secrets.scanLine(`"integrity": "${hash}"`, { file: 'x.json', line: 1 }, '').length, 0);
  assert.strictEqual(secrets.scanLine('"aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW"', { file: 'package-lock.json', line: 1 }, '').length, 0);
  assert.ok(secrets.scanLine(`key = "${FAKE_AWS}"`, { file: 'a.js', line: 1 }, '').length > 0);
});

test('buc scan-diff: flags tracked edits and untracked files, prints rule/file/line only, exit 1', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-scan-'));
  const sh = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  const scan = () => spawnSync('node', [path.join(__dirname, '..', 'bin', 'buc'), 'scan-diff'], { cwd: dir, encoding: 'utf8' });
  sh('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\n');
  sh('add', '.');
  sh('commit', '-qm', 'init');
  assert.strictEqual(scan().status, 0);
  const key = ['sk_', 'live_', 'A1b2C3d4E5f6G7h8'].join('');
  fs.appendFileSync(path.join(dir, 'a.js'), `const k = '${key}';\n`);
  fs.writeFileSync(path.join(dir, 'new.env'), `X=1\nSTRIPE=${key}\n`);
  const r = scan();
  assert.strictEqual(r.status, 1);
  assert.deepStrictEqual(r.stdout.trim().split('\n').sort(), ['stripe-key a.js:2', 'stripe-key new.env:2']);
  assert.ok(!r.stdout.includes(key));
});

test('buc scan-diff: untracked .env with a secret warns (exit 0); value never printed', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-scan-env-'));
  const sh = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  sh('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\n');
  sh('add', '.');
  sh('commit', '-qm', 'init');
  const key = ['sk_', 'live_', 'A1b2C3d4E5f6G7h8'].join('');
  fs.writeFileSync(path.join(dir, '.env'), `STRIPE_KEY=${key}\n`);
  const r = spawnSync('node', [path.join(__dirname, '..', 'bin', 'buc'), 'scan-diff'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /^warn \.env: untracked secret file/m);
  assert.ok(!r.stdout.includes(key));
});

test('secrets: default fingerprint salt is per-repo, so same value differs across repos', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const key = ['sk_', 'live_', 'A1b2C3d4E5f6G7h8'].join('');
  const fp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-salt-'));
    const sh = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
    sh('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.js'), `const k = '${key}';\n`);
    sh('add', '.');
    sh('commit', '-qm', 'init');
    const r = secrets.run({ dir, distDir: path.join(dir, 'dist') });
    return r.findings[0].fingerprint;
  };
  const [a, b] = [fp(), fp()];
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a, secrets.fingerprint(key, ''));
});

test('preflight secret scan of a subdirectory app ignores the rest of the repo', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const { scanDiff, scanCommits } = require('../lib/preflight/secrets');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-sub-'));
  const sh = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  sh('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app', 'a.js'), 'x\n');
  sh('add', '.'); sh('commit', '-qm', 'init');
  const key = ['sk_', 'live_', 'A1b2C3d4E5f6G7h8'].join('');
  fs.writeFileSync(path.join(dir, 'other.js'), `const k = '${key}';\n`);
  sh('add', '.'); sh('commit', '-qm', 'outside app');
  const app = path.join(dir, 'app');
  assert.strictEqual(scanDiff(app, 'HEAD~1', 'HEAD', 's').length, 0);
  assert.strictEqual(scanCommits(app, 'HEAD~1', 'HEAD', 's').length, 0);
  assert.ok(scanDiff(dir, 'HEAD~1', 'HEAD', 's').length > 0);
});
