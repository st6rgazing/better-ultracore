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

module.exports = { relayed };
