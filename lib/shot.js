'use strict';
// A screenshot of the running app for the agent to look at: start the dev server, capture 1280x800, stop the server.
// Nothing here throws at the caller for a missing engine or server: shot() answers {status: 'skipped', reason}.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');
const net = require('node:net');
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

// Kills every server still running, at once. For exit and signal handlers: nothing may outlive the process.
function stopAll() {
  for (const pid of running) signalGroup(pid, 'SIGKILL');
  running.clear();
}

module.exports = { freePort, playwrightServer, resolveServer, findEngine, ping, waitFor, startServer, stopServer, stopAll };
