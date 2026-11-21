'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const shot = require('../lib/shot');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'ui-app');
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const write = (dir, f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };

test('freePort gives a port that can be bound', async () => {
  const port = await shot.freePort();
  assert.ok(port > 1024);
  await new Promise((resolve, reject) => {
    const s = net.createServer().on('error', reject).listen(port, '127.0.0.1', () => s.close(resolve));
  });
});

test('resolveServer: buc.json first, then the Playwright webServer, then vite, else skipped', () => {
  const dir = tmp('buc-shot-');
  assert.match(shot.resolveServer(dir, 4000).skip, /no dev server found/);
  write(dir, 'node_modules/.bin/vite', '');
  assert.deepStrictEqual(shot.resolveServer(dir, 4000), { source: 'vite', command: `"${path.join(dir, 'node_modules/.bin/vite')}" --port 4000 --strictPort`, waitUrl: 'http://localhost:4000', url: 'http://localhost:4000', env: {} });
  write(dir, 'playwright.config.ts', "export default { use: { baseURL: 'http://localhost:3100' }, webServer: {\n  command: 'npm start',\n  url: 'http://localhost:3100/health',\n  env: { PORT: '3100', MODE: \"e2e\" },\n},\n};\n");
  assert.deepStrictEqual(shot.resolveServer(dir, 4000), { source: 'playwright', command: 'npm start', waitUrl: 'http://localhost:3100/health', url: 'http://localhost:3100', env: { PORT: '3100', MODE: 'e2e' } });
  write(dir, '.claude/buc.json', JSON.stringify({ ui: { dev: 'node server.js --port {port}' } }));
  assert.deepStrictEqual(shot.resolveServer(dir, 4000), { source: 'buc.json', command: 'node server.js --port 4000', waitUrl: 'http://localhost:4000', url: 'http://localhost:4000', env: { PORT: '4000' } });
  write(dir, '.claude/buc.json', JSON.stringify({ ui: { url: 'http://localhost:5173' } }));
  assert.deepStrictEqual(shot.resolveServer(dir, 4000), { source: 'buc.json', command: '', waitUrl: 'http://localhost:5173', url: 'http://localhost:5173', env: {} });
  write(dir, '.claude/buc.json', JSON.stringify({ ui: false }));
  assert.match(shot.resolveServer(dir, 4000).skip, /screenshots are off/);
});

test('playwrightServer reads the repo fixture config, a port-only config, and gives null without a webServer', () => {
  const pw = shot.playwrightServer(path.join(ROOT, 'fixtures', 'vite-express'));
  assert.strictEqual(pw.command, 'npm run build && npm start');
  assert.strictEqual(pw.waitUrl, 'http://localhost:3100/__version');
  assert.strictEqual(pw.url, 'http://localhost:3100');
  assert.deepStrictEqual(pw.env, { PORT: '3100', TEST_HOOKS: '1' });
  const dir = tmp('buc-shot-');
  write(dir, 'playwright.config.js', "module.exports = { webServer: {\n  command: `npm run dev`,\n  port: 4321,\n} };\n");
  assert.deepStrictEqual(shot.playwrightServer(dir), { source: 'playwright', command: 'npm run dev', waitUrl: 'http://localhost:4321', url: 'http://localhost:4321', env: {} });
  write(dir, 'playwright.config.js', "module.exports = { testDir: 'e2e' };\n");
  assert.strictEqual(shot.playwrightServer(dir), null);
  assert.strictEqual(shot.playwrightServer(tmp('buc-shot-')), null);
});

// Runs fn with env set, restoring the old values after (also when fn is async).
async function withEnv(env, fn) {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('findEngine: none when forced off, a named Chrome binary, a Playwright module by path', async () => {
  const dir = tmp('buc-shot-');
  write(dir, 'chrome', '');
  write(dir, 'pw/index.js', 'module.exports = { chromium: { launch() {} } };\n');
  write(dir, 'notpw/index.js', 'module.exports = {};\n');
  await withEnv({ BUC_SHOT_ENGINE: 'none', BUC_CHROME: path.join(dir, 'chrome'), BUC_PLAYWRIGHT: '' }, () => assert.strictEqual(shot.findEngine(dir), null));
  await withEnv({ BUC_SHOT_ENGINE: 'chrome', BUC_CHROME: path.join(dir, 'chrome'), BUC_PLAYWRIGHT: path.join(dir, 'pw') }, () => {
    assert.deepStrictEqual(shot.findEngine(dir), { kind: 'chrome', bin: path.join(dir, 'chrome') });
  });
  await withEnv({ BUC_SHOT_ENGINE: 'playwright', BUC_PLAYWRIGHT: path.join(dir, 'pw') }, () => assert.strictEqual(shot.findEngine(dir).kind, 'playwright'));
  await withEnv({ BUC_SHOT_ENGINE: 'playwright', BUC_PLAYWRIGHT: path.join(dir, 'notpw') }, () => assert.strictEqual(shot.findEngine(dir), null));
});

test('startServer and stopServer: the fixture server answers, then nothing is left listening', async () => {
  const port = await shot.freePort();
  const url = `http://127.0.0.1:${port}/`;
  assert.strictEqual(await shot.ping(url), false);
  // Through a shell with a second command, as npm scripts do: the group kill must reach the node child.
  const child = shot.startServer('true && node server.js', FIXTURE, { PORT: String(port) });
  try {
    assert.strictEqual(await shot.waitFor(url, 10000), true);
  } finally {
    await shot.stopServer(child);
  }
  assert.strictEqual(await shot.ping(url), false);
  assert.strictEqual(await shot.waitFor(url, 300), false);
  await shot.stopServer(null);
});

test('stopAll kills a server that was never stopped', async () => {
  const port = await shot.freePort();
  const url = `http://127.0.0.1:${port}/`;
  shot.startServer('node server.js', FIXTURE, { PORT: String(port) });
  assert.strictEqual(await shot.waitFor(url, 10000), true);
  shot.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(await shot.ping(url), false);
});

// end
