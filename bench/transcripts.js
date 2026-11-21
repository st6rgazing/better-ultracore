'use strict';
// Reads Claude Code transcripts for offline bench tooling (replay, intent eval). Read-only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { relayed, transcripts } = require('./mine-cases');

const HARNESS = /^\s*<|system-reminder|^\s*\[Request interrupted|^\/\w|^Caveat:|^This session is being continued/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

// One transcript as {file, session, start, end, cwd, turns}. A turn is a user text message typed by the person
// (no tool results, harness notes or sidechains): {session, idx, ts, text, cwd, image, tools, edits, files}, where
// files are the paths the assistant edited before the next user turn.
function sessionTurns(file) {
  const turns = [];
  let cur = null;
  let end = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || !o.message || o.isSidechain) continue;
    if (o.timestamp) end = o.timestamp;
    const c = o.message.content;
    if (o.type === 'assistant') {
      for (const b of cur && Array.isArray(c) ? c : []) {
        if (!b || b.type !== 'tool_use') continue;
        cur.tools += 1;
        if (!EDIT_TOOLS.has(b.name)) continue;
        cur.edits += 1;
        const f = b.input && (b.input.file_path || b.input.notebook_path);
        if (typeof f === 'string' && !cur.files.includes(f)) cur.files.push(f);
      }
      continue;
    }
    if (o.type !== 'user' || o.isMeta || o.isCompactSummary) continue;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    if (blocks.some((b) => b && b.type === 'tool_result')) continue;
    let text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
    if (!text) continue;
    if (/<wake\b/.test(text)) {
      const human = relayed(text);
      if (!human.length) continue;
      text = human.join('\n');
    } else if (HARNESS.test(text)) continue;
    cur = {
      session: o.sessionId || path.basename(file, '.jsonl'), idx: turns.length, ts: o.timestamp || end || '', text, cwd: o.cwd || '',
      image: blocks.some((b) => b && b.type === 'image') || /\[Image #\d+\]/.test(text), tools: 0, edits: 0, files: [],
    };
    turns.push(cur);
  }
  const first = turns[0];
  return { file, session: first ? first.session : path.basename(file, '.jsonl'), start: first ? first.ts : '', end: end || '', cwd: first ? first.cwd : '', turns };
}

// Every real session with at least one typed turn, oldest first. Temp, bench and scratch project dirs are skipped.
function allSessions(root = PROJECTS) {
  return transcripts(root).map(sessionTurns).filter((s) => s.turns.length && s.start)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.session < b.session ? -1 : 1));
}

module.exports = { sessionTurns, allSessions, PROJECTS };
