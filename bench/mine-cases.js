#!/usr/bin/env node
'use strict';
// Builds the held-out real-task set from Claude Code transcripts and git history. See bench/README.md.
// Source repos are only read (rev-list, diff, clone from); nothing is ever written to them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { rng } = require('./stats');
const { redact } = require('../lib/prefs/redact');

const TEMP_DIR = /(^|-)(tmp|private-tmp|var-folders|bench|scratch|worktrees)(-|$)/;
const HARNESS = /^\s*<|system-reminder|^\s*\[Request interrupted|^\/\w|^Caveat:|^This session is being continued/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Same cue and length limit as lib/rules/mine.js: what the rule miner could see.
const CUE = /^\s*(no\b|nope|don'?t|do not|stop|still|undo|revert|wrong|not working|i said|only|always|never|that'?s not|why did you|you (changed|didn'?t|forgot))|\b(not working|doesn'?t work|still (broken|not|fails?)|i (said|asked)|only (the|what)|too much|again)\b/i;
const MINER_MAX_LEN = 240;
const UI_FILE = /\.(css|scss|tsx|jsx|vue|svelte|html)$/;

const unescape = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Human messages relayed into a session by a project channel: <message trigger="true" from="human" ...>text</message>.
function relayed(text) {
  const out = [];
  const re = /<message\b([^>]*)>([\s\S]*?)<\/message>/g;
  let m;
  while ((m = re.exec(text))) if (/trigger="true"/.test(m[1]) && /from="human"/.test(m[1])) out.push(unescape(m[2]).trim());
  return out.filter(Boolean);
}

// One transcript -> ordered user text turns, each with the tool calls made before the next user turn.
// Sidechain, meta, tool-result and harness entries are not turns.
function parseSession(file) {
  const turns = [];
  let cur = null;
  let end = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || !o.message || o.isSidechain) continue;
    if (o.timestamp) end = o.timestamp;
    const c = o.message.content;
    if (o.type === 'assistant' && cur && Array.isArray(c)) {
      for (const b of c) {
        if (!b || b.type !== 'tool_use') continue;
        cur.tools++;
        if (EDIT_TOOLS.has(b.name)) cur.edits++;
        if (b.name === 'Agent' || b.name === 'Task') cur.spawns++;
        if (b.name === 'Bash' && /\bgit\b[^|;&]*\bcommit\b/.test((b.input && b.input.command) || '')) cur.commits++;
      }
      continue;
    }
    if (o.type !== 'user' || o.isMeta || o.isCompactSummary) continue;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    if (blocks.some((b) => b && b.type === 'tool_result')) continue;
    let text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
    if (!text) continue;
    const attached = /<wake\b[\s\S]*has-attachments?=|^\s*@"[^"]*\.(png|jpe?g|gif|webp)"/i.test(text);
    if (/<wake\b/.test(text)) {
      const human = relayed(text);
      if (!human.length) continue;
      text = human.join('\n');
    } else if (HARNESS.test(text)) continue;
    cur = { session: o.sessionId || path.basename(file, '.jsonl'), idx: turns.length, ts: o.timestamp, text, cwd: o.cwd || null, branch: o.gitBranch || null, image: attached || blocks.some((b) => b && b.type === 'image') || /\[Image #\d+\]/.test(text), tools: 0, edits: 0, commits: 0, spawns: 0 };
    turns.push(cur);
  }
  return { turns, end };
}

// Top-level transcripts of real projects; temp, bench and scratch project dirs are skipped, nested subagent files never visited.
function transcripts(root, skip = []) {
  const out = [];
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root).sort() : []) {
    if (TEMP_DIR.test(dir) || skip.some((s) => dir.includes(s))) continue;
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full).sort()) if (f.endsWith('.jsonl')) out.push(path.join(full, f));
  }
  return out;
}

const git = (repo, ...args) => {
  const p = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return p.status === 0 ? p.stdout.trim() : '';
};

const repoCache = new Map();
// The repo a turn ran in: git top level of its cwd, or null when the dir is gone or not a repo.
function repoOf(cwd) {
  if (!cwd) return null;
  if (!repoCache.has(cwd)) repoCache.set(cwd, fs.existsSync(cwd) ? git(cwd, 'rev-parse', '--show-toplevel') || null : null);
  return repoCache.get(cwd);
}

module.exports = { relayed, parseSession, transcripts, repoOf };
