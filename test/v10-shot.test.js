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

// end
