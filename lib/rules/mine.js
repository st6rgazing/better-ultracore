'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { userTurns, PERMISSION } = require('../prefs/import');
const { redact } = require('../prefs/redact');

const MAX_LEN = 240;
const CUE = /^\s*(no\b|nope|don'?t|do not|stop|still|undo|revert|wrong|not working|i said|only|always|never|that'?s not|why did you|you (changed|didn'?t|forgot))|\b(not working|doesn'?t work|still (broken|not|fails?)|i (said|asked)|only (the|what)|too much|again)\b/i;
const HARNESS = /^\s*<|system-reminder|^\s*\[|^\/\w/;
const TEMP_DIR = /(^|-)(tmp|private-tmp|var-folders|bench)(-|$)/;

// Short corrective user turns of one transcript, redacted; permission-shaped text is dropped.
function correctiveTurns(file) {
  const out = [];
  for (const t of userTurns(file)) {
    const text = t.text.trim();
    if (text.length > MAX_LEN || HARNESS.test(text) || !CUE.test(text) || PERMISSION.test(text)) continue;
    out.push({ session_id: t.sessionId, text: redact(text) });
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

module.exports = { correctiveTurns, mine };
