'use strict';
// A fallback screenshot is handed over only with evidence that the captured page shows the turn's change.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const shot = require('../lib/shot');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(os.tmpdir(), 'buc-shots');
const FIXTURE = path.join(__dirname, 'fixtures', 'ui-app');
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
// A Playwright module to test with: BUC_PLAYWRIGHT, else the one in the repo's vite-express fixture. '' when there is none.
function playwrightDir() {
  const dirs = [process.env.BUC_PLAYWRIGHT, path.join(ROOT, 'fixtures', 'vite-express', 'node_modules', 'playwright')].filter(Boolean);
  return dirs.find((d) => fs.existsSync(path.join(d, 'package.json'))) || '';
}
const NO_PW = !playwrightDir() && 'Playwright is not installed';

// Serves the fixture app and hands its URL to fn; the server is stopped whatever happens.
async function withServer(fn) {
  const port = await shot.freePort();
  const url = `http://127.0.0.1:${port}/`;
  const child = shot.startServer('node server.js', FIXTURE, { PORT: String(port) });
  try {
    assert.ok(await shot.waitFor(url, 10000));
    return await fn(url);
  } finally {
    await shot.stopServer(child);
  }
}

test('classesInHtml keeps the classes that appear in a class attribute, in any quoting', () => {
  const html = '<div class="card wide"><p class=\'fine\'>card-title</p><b class=bold>x</b></div>';
  assert.deepStrictEqual(shot.classesInHtml(html, ['wide', 'fine', 'bold', 'card-title', 'missing']), ['wide', 'fine', 'bold']);
  assert.deepStrictEqual(shot.classesInHtml('', ['a']), []);
  assert.deepStrictEqual(shot.classesInHtml('<i class="a">', undefined), []);
});

// A stand-in for Chrome: writes a file where --screenshot points and prints the given HTML for --dump-dom.
function fakeChrome(html = '') {
  const bin = path.join(tmp('buc-bin-'), 'fake-chrome');
  const body = `#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) printf PNGDATA > "\${a#--screenshot=}";; --dump-dom) cat <<'EOF'\n${html}\nEOF\n;; esac; done\n`;
  fs.writeFileSync(bin, body, { mode: 0o755 });
  return bin;
}

test('domChrome returns what the binary prints for --dump-dom, and nothing for a missing binary', async () => {
  const html = '<html><body><div class="card wide">hi</div></body></html>';
  assert.strictEqual((await shot.domChrome(fakeChrome(html), { url: 'http://127.0.0.1:9/' })).trim(), html);
  assert.strictEqual(await shot.domChrome(fakeChrome(), { url: 'http://127.0.0.1:9/' }), '\n');
  assert.strictEqual(await shot.domChrome(path.join(tmp('buc-bin-'), 'missing'), { url: 'http://127.0.0.1:9/' }), '');
});

// A copy of the fixture app in a temp dir with a dev server in .claude/buc.json.
function app() {
  const dir = tmp('buc-app-');
  for (const f of ['server.js', 'index.html']) fs.copyFileSync(path.join(FIXTURE, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'buc.json'), JSON.stringify({ ui: { dev: 'node server.js' } }));
  return dir;
}

// Runs fn with the given env set, restoring the old values after.
async function withEnv(env, fn) {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('shot with Chrome reads seen from a DOM dump: the classes found, none, or null when the dump is empty', async () => {
  const dir = app();
  const seen = (html, classes) => withEnv({ BUC_SHOT_ENGINE: 'chrome', BUC_CHROME: fakeChrome(html) }, async () => {
    const r = await shot.shot({ root: dir, out: path.join(dir, 's.png'), classes });
    assert.strictEqual(r.status, 'ok', r.reason);
    return r.seen;
  });
  assert.deepStrictEqual(await seen('<div class="card wide">hi</div>', ['wide', 'gone']), ['wide']);
  assert.deepStrictEqual(await seen('<div class="card">hi</div>', ['wide']), []);
  assert.strictEqual(await seen('', ['wide']), null);
  assert.strictEqual(await seen('<div class="wide">hi</div>', undefined), null);
  assert.strictEqual(await seen('<div class="wide">hi</div>', []), null);
});

// A git repo holding the fixture app, and a Stop hook run against it with a stand-in Chrome that dumps the given HTML.
function stopOn({ html, edit }) {
  const dir = app();
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('add', '.');
  git('commit', '-qm', 'init');
  const home = tmp('buc-home-');
  const turn = { session_id: 's', cwd: dir, root: dir, prompt: 'make the card wider', kind: 'edit', head: git('rev-parse', 'HEAD'), porcelain: '', rules: [], checks: [] };
  fs.writeFileSync(path.join(home, 'turn-s.json'), JSON.stringify(turn));
  for (const [f, s] of Object.entries(edit)) fs.writeFileSync(path.join(dir, f), s);
  const before = fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS).length : 0;
  const r = spawnSync('node', [path.join(ROOT, 'hooks', 'stop-check.js')], {
    input: JSON.stringify({ session_id: 's', cwd: dir, last_assistant_message: 'Done.' }), encoding: 'utf8',
    env: { ...process.env, BUC_HOME: home, BUC_OFF: '', BUC_SHOT_ENGINE: 'chrome', BUC_CHROME: fakeChrome(html), BUC_PLAYWRIGHT: '' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const left = (fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS).length : 0) - before;
  // A quiet Stop clears the turn file.
  const file = path.join(home, 'turn-s.json');
  return { out: r.stdout.trim() ? JSON.parse(r.stdout) : null, left, turn: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}

test('Stop fallback hands the screenshot over when the page shows a class the turn added', () => {
  const { out, turn } = stopOn({ html: '<div class="card wide">hi</div>', edit: { 'index.html': '<div class="card wide">hi</div>\n' } });
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /after your change, showing \.card, \.wide: (\S+\.png) \. Read it once/);
  fs.rmSync(text.match(/: (\S+\.png) /)[1]);
  assert.ok(turn.shotAt > 0);
});

test('Stop fallback stays quiet without evidence: the page lacks the classes, the DOM is unknown, or the turn added none', () => {
  const edit = { 'index.html': '<div class="card wide">hi</div>\n' };
  const elsewhere = stopOn({ html: '<div class="loader">...</div>', edit });
  assert.strictEqual(elsewhere.out, null, 'a page without the changed classes is not shown');
  assert.strictEqual(elsewhere.left, 0, 'the unused image is removed');
  assert.strictEqual(elsewhere.turn, null, 'nothing to continue for: the turn is closed');
  assert.strictEqual(stopOn({ html: '', edit }).out, null, 'no DOM, no evidence');
  const textOnly = stopOn({ html: '<p>Bye</p>', edit: { 'index.html': '<p>Bye</p>\n' } });
  assert.strictEqual(textOnly.out, null, 'added lines without a class name take no screenshot');
  const logic = stopOn({ html: '<div class="card">hi</div>', edit: { 'view.jsx': 'export const play = () => sound.start();\n' } });
  assert.strictEqual(logic.out, null, 'a logic-only change to a UI file takes no screenshot');
});

test('capturePlaywright reports which of the given classes the capture shows, waiting for a late one', { skip: NO_PW }, async () => {
  await withServer(async (url) => {
    const mod = require(playwrightDir());
    const dir = tmp('buc-seen-');
    const r = await shot.capturePlaywright(mod, { url, out: path.join(dir, 'a.png'), classes: ['card', 'nowhere', 'bad class'] });
    assert.deepStrictEqual(r, { findings: [], seen: ['card'] });
    assert.ok(fs.statSync(path.join(dir, 'a.png')).size > 5000);
    assert.deepStrictEqual((await shot.capturePlaywright(mod, { url, out: path.join(dir, 'b.png'), classes: [] })).seen, []);
    const t0 = Date.now();
    assert.deepStrictEqual((await shot.capturePlaywright(mod, { url, out: path.join(dir, 'c.png'), classes: ['nowhere'] })).seen, []);
    assert.ok(Date.now() - t0 >= 2500, 'an absent class is waited for before giving up');
  });
});

test('shot passes seen through with Playwright and leaves it null without classes', { skip: NO_PW }, async () => {
  const dir = tmp('buc-app-');
  for (const f of ['server.js', 'index.html']) fs.copyFileSync(path.join(FIXTURE, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'buc.json'), JSON.stringify({ ui: { dev: 'node server.js' } }));
  const old = { e: process.env.BUC_SHOT_ENGINE, p: process.env.BUC_PLAYWRIGHT };
  Object.assign(process.env, { BUC_SHOT_ENGINE: 'playwright', BUC_PLAYWRIGHT: playwrightDir() });
  try {
    const r = await shot.shot({ root: dir, out: path.join(dir, 's.png'), classes: ['save', 'gone'] });
    assert.strictEqual(r.status, 'ok', r.reason);
    assert.deepStrictEqual(r.seen, ['save']);
    assert.strictEqual((await shot.shot({ root: dir, out: path.join(dir, 't.png') })).seen, null);
  } finally {
    for (const [k, v] of [['BUC_SHOT_ENGINE', old.e], ['BUC_PLAYWRIGHT', old.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('shownClasses keeps classes on a visible element and drops hidden or absent ones', { skip: NO_PW }, async () => {
  await withServer(async (url) => {
    const mod = require(playwrightDir());
    const browser = await mod.chromium.launch().catch(() => mod.chromium.launch({ channel: 'chrome' }));
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.evaluate(() => { document.querySelector('.fine').style.display = 'none'; });
      assert.deepStrictEqual(await page.evaluate(shot.shownClasses, ['card', 'fine', 'nowhere', 'save']), ['card', 'save']);
    } finally {
      await browser.close().catch(() => {});
    }
  });
});
