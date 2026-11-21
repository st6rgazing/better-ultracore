'use strict';
// A fallback screenshot is handed over only with evidence that the captured page shows the turn's change.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const shot = require('../lib/shot');

const ROOT = path.join(__dirname, '..');
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
