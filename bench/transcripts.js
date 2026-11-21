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

const oldestFirst = (a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.session < b.session ? -1 : 1);

// Every real session with at least one typed turn, oldest first. Temp, bench and scratch project dirs are skipped.
function allSessions(root = PROJECTS) {
  return transcripts(root).map(sessionTurns).filter((s) => s.turns.length && s.start).sort(oldestFirst);
}

// Splits every session with typed turns on several calendar days (UTC) into one unit per day, so a replay can learn
// between the days of one long session. A unit has its own id, <session>@<day>, and a transcript holding only that
// day's lines, written under dir. dir must be outside the repo: the files are copies of private text.
function byDay(sessions, dir) {
  const target = require('./ask').outside(dir);
  const out = [];
  for (const s of sessions) {
    const days = [...new Set(s.turns.map((t) => String(t.ts).slice(0, 10)))];
    if (days.length < 2) { out.push(s); continue; }
    const lines = new Map(days.map((d) => [d, []]));
    let day = days[0];
    for (const raw of fs.readFileSync(s.file, 'utf8').split('\n')) {
      let o;
      try { o = JSON.parse(raw); } catch { continue; }
      if (!o) continue;
      // Lines from a day without a typed turn stay with the day before.
      const d = typeof o.timestamp === 'string' ? o.timestamp.slice(0, 10) : day;
      if (lines.has(d)) day = d;
      if (o.sessionId) o.sessionId = `${s.session}@${day}`;
      lines.get(day).push(JSON.stringify(o));
    }
    fs.mkdirSync(target, { recursive: true });
    for (const d of days) {
      const file = path.join(target, `${s.session}@${d}.jsonl`);
      fs.writeFileSync(file, `${lines.get(d).join('\n')}\n`);
      const unit = sessionTurns(file);
      if (unit.turns.length) out.push(unit);
    }
  }
  return out.sort(oldestFirst);
}

module.exports = { sessionTurns, allSessions, byDay, PROJECTS };
