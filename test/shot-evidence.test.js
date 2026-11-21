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
