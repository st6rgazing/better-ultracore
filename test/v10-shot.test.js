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

// A stand-in for Chrome: writes a small file where --screenshot points, so capture tests need no browser.
function fakeChrome(dir) {
  const bin = path.join(dir, 'fake-chrome');
  fs.writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) printf PNGDATA > "${a#--screenshot=}";; esac; done\n', { mode: 0o755 });
  return bin;
}

// A Playwright module to test with: BUC_PLAYWRIGHT, else one installed in the repo's vite-express fixture. '' when there is none.
function playwrightDir() {
  const dirs = [process.env.BUC_PLAYWRIGHT, path.join(ROOT, 'fixtures', 'vite-express', 'node_modules', 'playwright')].filter(Boolean);
  return dirs.find((d) => fs.existsSync(path.join(d, 'package.json'))) || '';
}
const REAL_CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));

test('captureChrome runs the binary with a screenshot path and reports whether a file appeared', async () => {
  const dir = tmp('buc-shot-');
  const out = path.join(dir, 'a.png');
  assert.strictEqual(await shot.captureChrome(fakeChrome(dir), { url: 'http://127.0.0.1:9/', out }), true);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'PNGDATA');
  assert.strictEqual(await shot.captureChrome(path.join(dir, 'missing'), { url: 'http://127.0.0.1:9/', out: path.join(dir, 'b.png') }), false);
});

test('capturePlaywright clicks, saves a PNG and audits the lying-UI fixture', { skip: !playwrightDir() && 'Playwright is not installed' }, async () => {
  const port = await shot.freePort();
  const url = `http://127.0.0.1:${port}/`;
  const child = shot.startServer('node server.js', FIXTURE, { PORT: String(port) });
  const dir = tmp('buc-shot-');
  try {
    assert.ok(await shot.waitFor(url, 10000));
    const mod = require(playwrightDir());
    const capture = async (opts) => (await shot.capturePlaywright(mod, opts)).findings;
    const all = await capture({ url, out: path.join(dir, 'all.png'), audit: true, clicks: ['text=Details'] });
    assert.ok(fs.statSync(path.join(dir, 'all.png')).size > 5000);
    assert.ok(all.length <= 5);
    assert.match(all[0], /^horizontal overflow: the page is \d+px wide in a 1280px viewport; div\.banner/);
    assert.ok(all.some((f) => /^clipped text: div\.price-tag "Subscribe/.test(f)), all.join('\n'));
    assert.ok(all.some((f) => /^overlap: button\.save "Save" and button\.cancel "Cancel" share \d+x40px/.test(f)), all.join('\n'));
    const limited = await capture({ url, out: path.join(dir, 'l.png'), audit: true, classes: ['price-tag'] });
    assert.ok(limited.some((f) => f.startsWith('clipped text:')));
    assert.ok(!limited.some((f) => f.startsWith('overlap:')), 'findings outside the given classes are dropped');
    const none = await capture({ url, out: path.join(dir, 'n.png'), audit: true, classes: [] });
    assert.deepStrictEqual(none.map((f) => f.split(':')[0]), ['horizontal overflow']);
    assert.deepStrictEqual(await shot.capturePlaywright(mod, { url, out: path.join(dir, 'p.png') }), { findings: [], seen: null });
  } finally {
    await shot.stopServer(child);
  }
  assert.strictEqual(await shot.ping(url), false);
});

// A copy of the fixture app in a temp dir, with the given .claude/buc.json. Returns the dir.
function app(conf = { ui: { dev: 'node server.js' } }) {
  const dir = tmp('buc-app-');
  for (const f of ['server.js', 'index.html']) fs.copyFileSync(path.join(FIXTURE, f), path.join(dir, f));
  if (conf) write(dir, '.claude/buc.json', JSON.stringify(conf));
  return dir;
}

test('shot: skipped with no engine, no server, ui off, or a server that never answers; never throws', async () => {
  const dir = app();
  await withEnv({ BUC_SHOT_ENGINE: 'none' }, async () => {
    assert.deepStrictEqual(await shot.shot({ root: dir }), { status: 'skipped', reason: 'no browser engine: install Playwright in the repo or Google Chrome' });
  });
  await withEnv({ BUC_SHOT_ENGINE: 'chrome', BUC_CHROME: fakeChrome(dir) }, async () => {
    assert.match((await shot.shot({ root: app(null) })).reason, /no dev server found/);
    assert.match((await shot.shot({ root: app({ ui: false }) })).reason, /screenshots are off/);
    const dead = app({ ui: { dev: 'node -e "setTimeout(() => {}, 60000)"' } });
    const r = await shot.shot({ root: dead, timeoutMs: 1500 });
    assert.strictEqual(r.status, 'skipped');
    assert.match(r.reason, /the server did not answer at http:\/\/localhost:\d+ within \d+ s/);
    assert.match((await shot.shot({ root: path.join(dir, 'nowhere') })).status, /skipped/);
  });
});

test('shot with a stand-in browser: writes the PNG, reports ignored clicks, and leaves no server running', async () => {
  const dir = app();
  await withEnv({ BUC_SHOT_ENGINE: 'chrome', BUC_CHROME: fakeChrome(dir) }, async () => {
    const out = path.join(dir, 'out', 'shot.png');
    const r = await shot.shot({ root: dir, path: '/settings', out, clicks: ['text=Details'], audit: true });
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.png, out);
    assert.strictEqual(r.engine, 'chrome');
    assert.match(r.url, /^http:\/\/localhost:\d+\/settings$/);
    assert.deepStrictEqual(r.findings, []);
    assert.deepStrictEqual(r.notes, ['clicks were ignored: they need Playwright in the repo', 'no layout audit: it needs Playwright in the repo']);
    assert.ok(fs.existsSync(out));
    assert.strictEqual(await shot.ping(r.url), false, 'the server it started is gone');
    const auto = await shot.shot({ root: dir });
    assert.ok(auto.png.startsWith(path.join(os.tmpdir(), 'buc-shots')));
    fs.rmSync(auto.png);
  });
});

test('shot uses a server that is already running and does not stop it', async () => {
  const port = await shot.freePort();
  const url = `http://localhost:${port}`;
  const dir = app({ ui: { dev: 'node server.js', url } });
  const mine = shot.startServer('node server.js', dir, { PORT: String(port) });
  try {
    assert.ok(await shot.waitFor(url, 10000));
    await withEnv({ BUC_SHOT_ENGINE: 'chrome', BUC_CHROME: fakeChrome(dir) }, async () => {
      assert.strictEqual((await shot.shot({ root: dir, out: path.join(dir, 's.png') })).status, 'ok');
    });
    assert.strictEqual(await shot.ping(url), true, 'still up: it was not ours to stop');
  } finally {
    await shot.stopServer(mine);
  }
});

test('shot with real Chrome gives a PNG over 5 kB and leaves no server', { skip: !REAL_CHROME && 'Chrome is not installed' }, async () => {
  const dir = app();
  await withEnv({ BUC_SHOT_ENGINE: 'chrome', BUC_CHROME: '' }, async () => {
    const r = await shot.shot({ root: dir, out: path.join(dir, 'real.png'), timeoutMs: 45000 });
    assert.strictEqual(r.status, 'ok', r.reason);
    assert.ok(fs.statSync(r.png).size > 5000);
    assert.strictEqual(fs.readFileSync(r.png).subarray(1, 4).toString(), 'PNG');
    assert.strictEqual(await shot.ping(r.url), false);
  });
});

test('shot with Playwright audits the lying UI and limits findings to the given classes', { skip: !playwrightDir() && 'Playwright is not installed' }, async () => {
  const dir = app();
  await withEnv({ BUC_SHOT_ENGINE: 'playwright', BUC_PLAYWRIGHT: playwrightDir() }, async () => {
    const r = await shot.shot({ root: dir, out: path.join(dir, 'pw.png'), audit: true, classes: ['save'] });
    assert.strictEqual(r.status, 'ok', r.reason);
    assert.strictEqual(r.engine, 'playwright');
    assert.ok(fs.statSync(r.png).size > 5000);
    assert.deepStrictEqual(r.findings.map((f) => f.split(':')[0]), ['horizontal overflow', 'overlap']);
    assert.strictEqual(await shot.ping(r.url), false);
    const bad = await shot.shot({ root: dir, out: path.join(dir, 'bad.png'), clicks: ['text=No such control'], timeoutMs: 8000 });
    assert.strictEqual(bad.status, 'skipped');
    assert.match(bad.reason, /^capture failed: /);
    assert.strictEqual(await shot.ping(r.url), false);
  });
});

const CLI = path.join(ROOT, 'bin', 'buc-shot');
const cli = (args, env = {}, opts = {}) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, BUC_PLAYWRIGHT: '', ...env }, ...opts });

test('buc-shot exits 0 with "skipped" when no engine is available, and 2 on a bad option', () => {
  const dir = app();
  const r = cli(['--root', dir], { BUC_SHOT_ENGINE: 'none' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'skipped: no browser engine: install Playwright in the repo or Google Chrome');
  const j = cli(['--root', dir, '--json'], { BUC_SHOT_ENGINE: 'none' });
  assert.strictEqual(JSON.parse(j.stdout).status, 'skipped');
  const bad = cli(['--nope']);
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /unknown option --nope\nusage: buc-shot/);
  assert.strictEqual(cli(['--path']).status, 2);
});

test('buc-shot prints the PNG path first and leaves no server', async () => {
  const dir = app();
  const out = path.join(dir, 'cli.png');
  const r = cli(['--root', dir, '--path', '/a', '--out', out, '--click', 'text=Details', '--audit', '--classes', 'save, cancel'], { BUC_SHOT_ENGINE: 'chrome', BUC_CHROME: fakeChrome(dir) });
  assert.strictEqual(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.strictEqual(lines[0], `shot: ${out}`);
  assert.match(lines[1], /^url: http:\/\/localhost:\d+\/a \(chrome, 1280x800\)$/);
  assert.deepStrictEqual(lines.slice(2), ['note: clicks were ignored: they need Playwright in the repo', 'note: no layout audit: it needs Playwright in the repo']);
  assert.strictEqual(await shot.ping(lines[1].split(' ')[1]), false);
});

test('buc-shot killed mid-run takes its server down with it', async () => {
  const dir = app();
  // A browser that never finishes, so the CLI is still holding the server when the timeout kills it.
  const slow = path.join(dir, 'slow-chrome');
  fs.writeFileSync(slow, '#!/bin/sh\nfor a in "$@"; do case "$a" in http*) echo "$a" > "$(dirname "$0")/url.txt";; esac; done\necho $$ > "$(dirname "$0")/pid.txt"\nexec sleep 30\n', { mode: 0o755 });
  const r = cli(['--root', dir], { BUC_SHOT_ENGINE: 'chrome', BUC_CHROME: slow }, { timeout: 2500, killSignal: 'SIGTERM' });
  assert.strictEqual(r.signal || r.status, 143);
  const url = fs.readFileSync(path.join(dir, 'url.txt'), 'utf8').trim();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(await shot.ping(url), false);
  const pid = Number(fs.readFileSync(path.join(dir, 'pid.txt'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the browser is gone too');
});

test('buc-shot parse and render', () => {
  const { parse, render } = require('../bin/buc-shot');
  assert.deepStrictEqual(parse(['--path', '/x', '--click', 'a', '--click', 'b', '--audit', '--classes', '', '--timeout', '5']), { root: process.cwd(), path: '/x', clicks: ['a', 'b'], audit: true, json: false, classes: [], timeoutMs: 1000 });
  assert.throws(() => parse(['--out']), /--out needs a value/);
  assert.deepStrictEqual(render({ status: 'skipped', reason: 'why' }), ['skipped: why']);
  assert.deepStrictEqual(render({ status: 'ok', png: '/t/a.png', url: 'http://h/', engine: 'playwright', findings: ['overlap: a and b'], notes: [] }), ['shot: /t/a.png', 'url: http://h/ (playwright, 1280x800)', 'audit: overlap: a and b']);
});

test('isUiFile and classesIn', () => {
  assert.deepStrictEqual(['a.css', 'b.scss', 'c.tsx', 'd.jsx', 'e.vue', 'f.svelte', 'g.html', 'h.ts', 'i.js', 'j.md'].filter(shot.isUiFile), ['a.css', 'b.scss', 'c.tsx', 'd.jsx', 'e.vue', 'f.svelte', 'g.html']);
  const added = [
    { file: 'a.tsx', text: '<div className="card card--wide">' },
    { file: 'a.tsx', text: "<button class='save' className={`cta ${x}`}>" },
    { file: 'a.tsx', text: 'const n = 1.5; obj.prop = 2;' },
    { file: 's.css', text: '.price-tag, .banner > .inner {' },
    { file: 's.css', text: '  margin: 0.5rem;' },
    { file: 's.scss', text: '.card.wide { color: red; }' },
  ];
  assert.deepStrictEqual(shot.classesIn(added), ['card', 'card--wide', 'save', 'cta', 'price-tag', 'banner', 'inner', 'wide']);
  assert.deepStrictEqual(shot.classesIn([]), []);
});

test('shotSync returns the CLI result, and "skipped" when it cannot finish in time, with no server left', async () => {
  const dir = app();
  const ok = await withEnv({ BUC_SHOT_ENGINE: 'chrome', BUC_CHROME: fakeChrome(dir), BUC_PLAYWRIGHT: '' }, () => shot.shotSync({ root: dir, audit: true, classes: [], out: path.join(dir, 'sync.png') }));
  assert.strictEqual(ok.status, 'ok');
  assert.strictEqual(ok.png, path.join(dir, 'sync.png'));
  assert.strictEqual(await shot.ping(ok.url), false);
  const none = await withEnv({ BUC_SHOT_ENGINE: 'none' }, () => shot.shotSync({ root: dir }));
  assert.strictEqual(none.status, 'skipped');
  const slow = path.join(dir, 'slow-chrome');
  fs.writeFileSync(slow, '#!/bin/sh\nfor a in "$@"; do case "$a" in http*) echo "$a" > "$(dirname "$0")/url.txt";; esac; done\nexec sleep 30\n', { mode: 0o755 });
  const t0 = Date.now();
  const late = await withEnv({ BUC_SHOT_ENGINE: 'chrome', BUC_CHROME: slow, BUC_PLAYWRIGHT: '' }, () => shot.shotSync({ root: dir, timeoutMs: 6500 }));
  assert.strictEqual(late.status, 'skipped');
  assert.ok(Date.now() - t0 < 6500, 'the child stops itself before the hard deadline');
  assert.strictEqual(await shot.ping(fs.readFileSync(path.join(dir, 'url.txt'), 'utf8').trim()), false);
});

// end
