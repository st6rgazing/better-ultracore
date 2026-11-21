'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PERMISSION } = require('../prefs/import');
const { redact } = require('../prefs/redact');
const { repoKey } = require('../context');
const { hash } = require('./store');

const MAX_LEN = 240;
const CUE = /^\s*(no\b|nope|don'?t|do not|stop|still|undo|revert|wrong|not working|i said|only|always|never|that'?s not|why did you|you (changed|didn'?t|forgot))|\b(not working|doesn'?t work|still (broken|not|fails?)|i (said|asked)|only (the|what)|too much|again)\b/i;
const HARNESS = /^\s*<|system-reminder|^\s*\[|^\/\w/;
const TEMP_DIR = /(^|-)(tmp|private-tmp|var-folders|bench)(-|$)/;

// User text turns of one transcript with the turn's own timestamp and working directory.
function* userTurns(file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.type !== 'user' || !entry.message) continue;
    const { content } = entry.message;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
    if (text.trim()) yield { sessionId: entry.sessionId || 'unknown', text, ts: typeof entry.timestamp === 'string' ? entry.timestamp : '', cwd: typeof entry.cwd === 'string' ? entry.cwd : '' };
  }
}

const repoCache = new Map();

// Repo key of a transcript's cwd: the git repo's key when the directory still exists, else its basename.
function repoOf(cwd) {
  if (!cwd) return '';
  if (!repoCache.has(cwd)) {
    let key = path.basename(cwd);
    try {
      if (fs.existsSync(cwd)) key = repoKey(execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch { /* not a repo */ }
    repoCache.set(cwd, key);
  }
  return repoCache.get(cwd);
}

// Short corrective user turns of one transcript, redacted; permission-shaped text is dropped.
// Each is {session_id, text, repo, h, ts?}: ts is the turn's own time, h the provenance hash of the text.
function correctiveTurns(file) {
  const out = [];
  for (const t of userTurns(file)) {
    const text = t.text.trim();
    if (text.length > MAX_LEN || HARNESS.test(text) || !CUE.test(text) || PERMISSION.test(text)) continue;
    const clean = redact(text);
    out.push({ session_id: t.sessionId, text: clean, repo: repoOf(t.cwd), h: hash(clean), ...(t.ts && { ts: t.ts }) });
  }
  return out;
}

function* transcripts(root) {
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (TEMP_DIR.test(dir)) continue;
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) if (f.endsWith('.jsonl')) yield path.join(full, f);
  }
}

// Candidate corrections across all projects; subagent transcripts live in nested dirs and are never visited.
function mine(root) {
  const seen = new Set();
  const out = [];
  for (const f of transcripts(root)) {
    for (const c of correctiveTurns(f)) {
      const key = c.text.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c);
      }
    }
  }
  return out;
}

module.exports = { correctiveTurns, mine, repoOf };
