'use strict';
// A screenshot of the running app for the agent to look at: start the dev server, capture 1280x800, stop the server.
// Nothing here throws at the caller for a missing engine or server: shot() answers {status: 'skipped', reason}.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// A free TCP port on this machine.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// The Playwright config's webServer, read as text (the config is never executed): {source, command, waitUrl, url, env} or null.
// waitUrl is what the config polls; url is the page base (use.baseURL, else the origin of waitUrl).
function playwrightServer(root) {
  const file = ['js', 'ts', 'mjs', 'cjs', 'mts'].map((e) => path.join(root, `playwright.config.${e}`)).find((f) => fs.existsSync(f));
  if (!file) return null;
  const src = fs.readFileSync(file, 'utf8');
  const block = (src.match(/\bwebServer\s*:\s*\[?\s*\{([\s\S]*?)\n\s*\}/) || [])[1];
  if (!block) return null;
  const str = (text, key) => (text.match(new RegExp(`\\b${key}\\s*:\\s*(['"\`])(.+?)\\1`)) || [])[2];
  const command = str(block, 'command');
  const port = (block.match(/\bport\s*:\s*(\d+)/) || [])[1];
  const waitUrl = str(block, 'url') || (port ? `http://localhost:${port}` : '');
  if (!command || !waitUrl) return null;
  let url = str(src.replace(block, ''), 'baseURL');
  try { url = url || new URL(waitUrl).origin; } catch { return null; }
  const envBlock = (block.match(/\benv\s*:\s*\{([^}]*)\}/) || [])[1] || '';
  const env = Object.fromEntries([...envBlock.matchAll(/(\w+)\s*:\s*(['"`])(.*?)\2/g)].map((m) => [m[1], m[3]]));
  return { source: 'playwright', command, waitUrl, url, env };
}

// Where the app is served, first match wins: "ui" in <root>/.claude/buc.json ({dev, url}; `false` turns screenshots off),
// the Playwright webServer, then the repo's own vite on the given free port.
// Returns {source, command, waitUrl, url, env} (command '' means: use the server already at url) or {skip: reason}.
function resolveServer(root, port) {
  const conf = readJson(path.join(root, '.claude', 'buc.json')) || {};
  if (conf.ui === false) return { skip: 'screenshots are off ("ui": false in .claude/buc.json)' };
  const ui = conf.ui && typeof conf.ui === 'object' ? conf.ui : {};
  if (ui.dev || ui.url) {
    // Without a url the command gets the free port: as $PORT and in place of {port}.
    const url = String(ui.url || `http://localhost:${port}`);
    const command = String(ui.dev || '').replace(/\{port\}/g, String(port));
    return { source: 'buc.json', command, waitUrl: url, url, env: ui.url ? {} : { PORT: String(port) } };
  }
  const pw = playwrightServer(root);
  if (pw) return pw;
  const vite = path.join(root, 'node_modules', '.bin', 'vite');
  if (fs.existsSync(vite)) {
    const url = `http://localhost:${port}`;
    return { source: 'vite', command: `"${vite}" --port ${port} --strictPort`, waitUrl: url, url, env: {} };
  }
  return { skip: 'no dev server found: set "ui": {"dev": "<command>", "url": "<url>"} in .claude/buc.json' };
}

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

// The browser to capture with: the repo's own Playwright ({kind: 'playwright', mod}), else an installed Chrome ({kind: 'chrome', bin}), else null.
// BUC_SHOT_ENGINE=none|chrome|playwright narrows the choice; BUC_PLAYWRIGHT names a Playwright module directory; BUC_CHROME names a Chrome binary.
function findEngine(root) {
  const only = process.env.BUC_SHOT_ENGINE || '';
  if (only === 'none') return null;
  if (only !== 'chrome') {
    for (const name of [process.env.BUC_PLAYWRIGHT, 'playwright', '@playwright/test', 'playwright-core'].filter(Boolean)) {
      try {
        const mod = require(require.resolve(name, { paths: [root] }));
        if (mod && mod.chromium) return { kind: 'playwright', mod };
      } catch { /* not installed in this repo */ }
    }
  }
  if (only === 'playwright') return null;
  const bin = [process.env.BUC_CHROME, ...CHROME_PATHS].filter(Boolean).find((p) => fs.existsSync(p));
  return bin ? { kind: 'chrome', bin } : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// True when the URL answers with anything below 500.
function ping(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Polls until the URL answers or `ms` have passed.
async function waitFor(url, ms) {
  const end = Date.now() + ms;
  do {
    if (await ping(url)) return true;
    await sleep(200);
  } while (Date.now() < end);
  return false;
}

// Process groups of servers this process started and has not stopped yet.
const running = new Set();
const signalGroup = (pid, sig) => { try { process.kill(-pid, sig); return true; } catch { return false; } };

// Starts the dev server in its own process group, so the shell and everything it spawns can be stopped together.
function startServer(command, root, env = {}) {
  const child = spawn(command, { shell: true, cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, BROWSER: 'none', ...env } });
  child.on('error', () => {});
  if (child.pid) running.add(child.pid);
  return child;
}

// Stops a server from startServer and waits until its whole group is gone: TERM, then KILL after 2 s.
async function stopServer(child) {
  if (!child || !child.pid) return;
  signalGroup(child.pid, 'SIGTERM');
  const end = Date.now() + 2000;
  while (Date.now() < end && signalGroup(child.pid, 0)) await sleep(50);
  signalGroup(child.pid, 'SIGKILL');
  running.delete(child.pid);
}

// Browser processes started by captureChrome that have not exited yet, with their temporary profile directory.
const browsers = new Map();

// Kills every server and browser still running, at once. For exit and signal handlers: nothing may outlive the process.
function stopAll() {
  for (const pid of running) signalGroup(pid, 'SIGKILL');
  running.clear();
  for (const [child, profile] of browsers) {
    child.kill('SIGKILL');
    fs.rmSync(profile, { recursive: true, force: true });
  }
  browsers.clear();
}

const VIEW = { width: 1280, height: 800 };
const MAX_FINDINGS = 5;
const SETTLE_MS = 3000;

// Runs inside the page. At most 5 layout findings: horizontal overflow of the page, text clipped by its own box, and
// interactive boxes that overlap. With `limited`, element findings are kept only for elements inside one of `classes`.
function auditPage({ classes, limited, max }) {
  const out = [];
  const vw = document.documentElement.clientWidth;
  const box = (el) => el.getBoundingClientRect();
  const shown = (el) => {
    const r = box(el);
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
  };
  const name = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}${text ? ` "${text}"` : ''}`;
  };
  const inScope = (el) => !limited || classes.some((c) => el.closest(`.${CSS.escape(c)}`));
  const all = [...document.querySelectorAll('body *')].filter(shown);

  const pageWidth = document.documentElement.scrollWidth;
  if (pageWidth > vw + 1) {
    const wide = all.filter((el) => box(el).right > vw + 1);
    const first = wide.find((el) => !wide.some((o) => o !== el && el.contains(o)));
    out.push(`horizontal overflow: the page is ${pageWidth}px wide in a ${vw}px viewport${first ? `; ${name(first)} reaches ${Math.round(box(first).right)}px` : ''}`);
  }
  for (const el of all) {
    if (out.length >= max) break;
    if (!inScope(el) || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el);
    const x = el.scrollWidth > el.clientWidth + 1 && /hidden|clip/.test(s.overflowX) && s.textOverflow !== 'ellipsis';
    const y = el.scrollHeight > el.clientHeight + 1 && /hidden|clip/.test(s.overflowY);
    if (x || y) out.push(`clipped text: ${name(el)} needs ${el.scrollWidth}x${el.scrollHeight}px and has ${el.clientWidth}x${el.clientHeight}px`);
  }
  const active = all.filter((el) => el.matches('a[href], button, input, select, textarea, [role="button"], [role="link"]'));
  for (let i = 0; i < active.length && out.length < max; i++) {
    for (let j = i + 1; j < active.length && out.length < max; j++) {
      const [a, b] = [active[i], active[j]];
      if (a.contains(b) || b.contains(a) || !(inScope(a) || inScope(b))) continue;
      const [ra, rb] = [box(a), box(b)];
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 4 && h > 4) out.push(`overlap: ${name(a)} and ${name(b)} share ${Math.round(w)}x${Math.round(h)}px`);
    }
  }
  return out.slice(0, max);
}

// Runs inside the page. Which of `classes` are on an element the user can see right now.
function shownClasses(classes) {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
  };
  return classes.filter((c) => [...document.getElementsByClassName(c)].some(shown));
}

// Which of `classes` appear in a class attribute of the HTML text. For engines that give the DOM as text only.
function classesInHtml(html, classes) {
  const present = new Set();
  for (const m of String(html || '').matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    for (const c of (m[1] || m[2] || m[3] || '').split(/\s+/)) present.add(c);
  }
  return (classes || []).filter((c) => present.has(c));
}

// Capture with Playwright: open the URL, click each selector in order, save the PNG, and audit the layout when asked.
// Returns {findings, seen}: seen lists the given classes that are visible in the capture (null when no classes were given).
// With classes, the capture first waits up to SETTLE_MS for one of them to show, so a hit is not a mid-load frame.
// Uses the bundled Chromium, else the installed Chrome. The browser is always closed.
async function capturePlaywright(mod, { url, clicks = [], out, audit = false, classes, ms = 30000 }) {
  const browser = await mod.chromium.launch().catch(() => mod.chromium.launch({ channel: 'chrome' }));
  try {
    const page = await browser.newPage({ viewport: VIEW });
    page.setDefaultTimeout(Math.max(1000, Math.min(ms, 10000)));
    await page.goto(url, { waitUntil: 'load', timeout: Math.max(1000, ms) });
    for (const selector of clicks) await page.click(selector);
    const named = Array.isArray(classes) ? classes.filter((c) => /^-?[A-Za-z_][\w-]*$/.test(c)) : null;
    if (named && named.length) {
      await page.waitForSelector(named.map((c) => `.${c}`).join(', '), { state: 'visible', timeout: Math.max(1, Math.min(SETTLE_MS, ms)) }).catch(() => {});
    }
    await page.waitForTimeout(250);
    await page.screenshot({ path: out });
    const seen = named ? await page.evaluate(shownClasses, named) : null;
    const findings = audit ? await page.evaluate(auditPage, { classes: classes || [], limited: Array.isArray(classes), max: MAX_FINDINGS }) : [];
    return { findings, seen };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Capture with a Chrome binary: `--headless=new --screenshot`. No clicks and no audit. Resolves true when the PNG exists.
function captureChrome(bin, { url, out, ms = 30000 }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-chrome-'));
  const args = ['--headless=new', `--screenshot=${out}`, `--window-size=${VIEW.width},${VIEW.height}`, '--hide-scrollbars', '--disable-gpu',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, url];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'ignore' });
    browsers.set(child, profile);
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(1000, ms));
    // Headless Chrome can stay alive after writing the file: stop it once the PNG has stopped growing.
    let size = 0;
    const poll = setInterval(() => {
      const now = fs.existsSync(out) ? fs.statSync(out).size : 0;
      if (now && now === size) child.kill('SIGKILL');
      size = now;
    }, 300);
    const done = () => {
      clearTimeout(timer);
      clearInterval(poll);
      browsers.delete(child);
      fs.rmSync(profile, { recursive: true, force: true });
      resolve(fs.existsSync(out) && fs.statSync(out).size > 0);
    };
    child.on('error', done).on('exit', done);
  });
}

// The page's DOM as HTML text from a Chrome binary (`--headless=new --dump-dom`), or '' when it gives none in time.
function domChrome(bin, { url, ms = 15000 }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-chrome-'));
  const args = ['--headless=new', '--dump-dom', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, url];
  return new Promise((resolve) => {
    let html = '';
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    browsers.set(child, profile);
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(1000, ms));
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browsers.delete(child);
      fs.rmSync(profile, { recursive: true, force: true });
      resolve(html);
    };
    if (child.stdout) child.stdout.on('data', (d) => { if (html.length < 2000000) html += d; });
    child.on('error', done).on('close', done);
  });
}

const SERVER_WAIT_MS = 20000;

// Rejects when the promise takes longer than ms.
const within = (promise, ms) => Promise.race([promise, sleep(Math.max(0, ms)).then(() => { throw new Error('timed out'); })]);

// One screenshot of `route` in the repo at `root`. Starts the dev server unless it already answers, waits up to 20 s for it,
// captures 1280x800 into `out` (default: a file in the OS temp dir) and stops the server it started, whatever happens.
// clicks: Playwright selectors clicked in order before the capture. audit: add layout findings (Playwright only);
// classes: when an array, limit element findings to those classes and report which of them the capture shows.
// Returns {status: 'ok', png, url, engine, findings, notes, seen} or {status: 'skipped', reason}. Never throws.
// seen: the given classes found on the captured page; null when none were given or the page could not be read.
async function shot({ root = process.cwd(), path: route = '/', clicks = [], out, audit = false, classes, timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const left = () => deadline - Date.now();
  const skipped = (reason) => ({ status: 'skipped', reason });
  let child = null;
  try {
    const engine = findEngine(root);
    if (!engine) return skipped('no browser engine: install Playwright in the repo or Google Chrome');
    const server = resolveServer(root, await freePort());
    if (server.skip) return skipped(server.skip);
    const url = new URL(route, server.url).href;
    const png = path.resolve(out || path.join(os.tmpdir(), 'buc-shots', `${path.basename(root)}-${Date.now()}.png`));
    fs.mkdirSync(path.dirname(png), { recursive: true });
    fs.rmSync(png, { force: true });
    if (server.command && !(await ping(server.waitUrl))) child = startServer(server.command, root, server.env);
    const wait = Math.min(SERVER_WAIT_MS, left());
    if (!(await waitFor(server.waitUrl, wait))) return skipped(`the server did not answer at ${server.waitUrl} within ${Math.round(wait / 1000)} s`);

    const notes = [];
    let findings = [];
    let seen = null;
    let used = engine.kind;
    if (engine.kind === 'playwright') {
      try {
        ({ findings, seen } = await within(capturePlaywright(engine.mod, { url, clicks, out: png, audit, classes, ms: left() }), left()));
      } catch (e) {
        return skipped(`capture failed: ${String(e.message || e).split('\n')[0].slice(0, 160)}`);
      }
    } else {
      if (clicks.length) notes.push('clicks were ignored: they need Playwright in the repo');
      if (audit) notes.push('no layout audit: it needs Playwright in the repo');
      await captureChrome(engine.bin, { url, out: png, ms: left() });
      used = 'chrome';
      // Chrome gives no live page to query: the classes are looked up in a DOM dump, when there is time left for one.
      if (Array.isArray(classes) && classes.length && left() > 2000) {
        const html = await domChrome(engine.bin, { url, ms: Math.min(15000, left()) });
        seen = html.trim() ? classesInHtml(html, classes) : null;
      }
    }
    if (!fs.existsSync(png) || !fs.statSync(png).size) return skipped('the browser produced no image');
    return { status: 'ok', png, url, engine: used, findings, notes, seen };
  } catch (e) {
    return skipped(`screenshot failed: ${String(e.message || e).split('\n')[0].slice(0, 160)}`);
  } finally {
    await stopServer(child);
  }
}

const UI_FILE = /\.(css|scss|tsx|jsx|vue|svelte|html)$/i;
const isUiFile = (f) => UI_FILE.test(f);

// Class names in added lines ({file, text}): class and className attributes in markup, selectors in style files. At most 40.
function classesIn(added) {
  const found = new Set();
  for (const { file, text } of added) {
    if (/\.s?css$/i.test(file)) {
      if (!/[{,]\s*$|^\s*\./.test(text)) continue;
      for (const m of text.split('{')[0].matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) found.add(m[1]);
    } else {
      for (const m of text.matchAll(/\bclass(?:Name)?\s*=\s*\{?\s*["'`]([^"'`]+)["'`]/g)) {
        for (const c of m[1].split(/\s+/)) if (/^-?[A-Za-z_][\w-]*$/.test(c)) found.add(c);
      }
    }
  }
  return [...found].slice(0, 40);
}

// Class names whose style rule the added lines touch: the selectors of added lines in style files only.
const styledClassesIn = (added) => classesIn(added.filter((a) => /\.s?css$/i.test(a.file)));

// shot() from synchronous code (the Stop hook): runs bin/buc-shot and gives up at timeoutMs. The child is told to finish
// 5 s earlier, and a kill at the deadline still takes its server down. Same result shape as shot(); never throws.
function shotSync({ root, path: route = '/', audit = false, classes, out, timeoutMs = 45000 } = {}) {
  const args = [path.join(__dirname, '..', 'bin', 'buc-shot'), '--json', '--root', root, '--path', route, '--timeout', String(Math.max(1000, timeoutMs - 5000))];
  if (audit) args.push('--audit');
  if (Array.isArray(classes)) args.push('--classes', classes.join(','));
  if (out) args.push('--out', out);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGTERM', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const res = JSON.parse(String(r.stdout || '').trim().split('\n').pop());
    if (res && (res.status === 'ok' || res.status === 'skipped')) return res;
  } catch { /* no result line */ }
  return { status: 'skipped', reason: r.error && r.error.code === 'ETIMEDOUT' ? `no screenshot within ${Math.round(timeoutMs / 1000)} s` : 'screenshot failed' };
}

module.exports = { shot, shotSync, isUiFile, classesIn, styledClassesIn, classesInHtml, shownClasses, freePort, playwrightServer, resolveServer, findEngine, ping, waitFor, startServer, stopServer, stopAll, auditPage, capturePlaywright, captureChrome, domChrome, VIEW };
