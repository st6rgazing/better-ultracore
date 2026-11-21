#!/usr/bin/env node
'use strict';
// Intent eval set: real request and follow-up turns with automatic evidence and a model pre-label, used to measure
// the precision of each fixed-line pattern in lib/intent.js. The set is private (bench/heldout/, gitignored); a
// synthetic paraphrase set for CI lives in test/fixtures/intent-eval.public.jsonl. See bench/README.md.
const fs = require('node:fs');
const path = require('node:path');
const intent = require('../lib/intent');
const { promptKind } = require('../lib/rules/retrieve');
const { isOps, minerVisible } = require('./mine-cases');
const { rng } = require('./stats');

const MAX_WORDS = 60;
const UI_FILE = /\.(css|scss|tsx|jsx|vue|svelte|html)$/;
const REQUEST_LABELS = ['exact', 'feature', 'sweep', 'vague', 'show', 'other'];
const FOLLOWUP_LABELS = ['still', 'misread', 'undo-show', 'overshoot', 'new-request'];

const words = (text) => text.trim().split(/\s+/).filter(Boolean).length;
const dayOf = (ts) => String(ts || '').slice(0, 10);

// What the hook would do with a turn: the follow-up pattern when one fires on a later turn, else the request pattern.
function fired(text, hadPrev) {
  const c = hadPrev ? intent.readCorrection(text, true).pattern : '';
  return c ? { followup: true, pattern: c } : { followup: false, pattern: intent.readIntent(text, { kind: promptKind(text), mode: 'self' }).pattern };
}

// Every usable turn of the sessions as an unlabelled row. A row is a follow-up when a correction pattern fires on
// it, or when it reacts to edits with a correction cue or in a few words; otherwise it is a request. Operational
// go-aheads, image turns and prompts over 60 words (the hook gives those no line) are left out.
// Row: {id, session, unit, ts, prompt, followup, prev?, evidence, regex}. evidence is what happened next: files the
// assistant edited before the next user turn, how many are UI files, and how the user reacted. unit is the session
// and day, the grain of the dev/test split.
function candidates(sessions) {
  const rows = [];
  for (const s of sessions) {
    s.turns.forEach((t, j) => {
      if (t.image || isOps(t.text) || words(t.text) > MAX_WORDS) return;
      const prev = j > 0 ? s.turns[j - 1] : null;
      const next = s.turns[j + 1];
      const hit = fired(t.text, Boolean(prev));
      const reacts = Boolean(prev) && prev.edits > 0 && (minerVisible(t.text) || words(t.text) <= 12);
      const reaction = next ? intent.readCorrection(next.text, true).pattern || (minerVisible(next.text) ? 'cue' : 'none') : 'end';
      rows.push({
        id: `${s.session.slice(0, 8)}:${t.idx}`, session: s.session, unit: `${s.session}@${dayOf(t.ts)}`, ts: t.ts, prompt: t.text,
        followup: hit.followup || (reacts && !hit.pattern.replace('self', '')),
        ...(prev && { prev: prev.text.slice(0, 300) }),
        evidence: { files: t.files.length, ui_files: t.files.filter((f) => UI_FILE.test(f)).length, next: reaction },
        regex: hit.pattern,
      });
    });
  }
  return rows;
}

function shuffled(items, next) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Seeded pick of the rows to label. Rows a fixed-line pattern fires on go first, at most perPattern each, so a rare
// pattern still gets enough fires to measure; precision is fires that were right over fires, so taking more fires
// does not bias it. Random rows then fill up to the totals. Repeats of the same prompt text are dropped.
function sample(rows, { requests = 200, followups = 60, perPattern = 24, seed = 10 } = {}) {
  const next = rng(seed);
  const seen = new Set();
  const unique = shuffled(rows, next).filter((r) => { const k = `${r.followup}|${r.prompt.trim().toLowerCase()}`; return !seen.has(k) && seen.add(k); });
  const take = (pool, total) => {
    const count = {};
    const fires = pool.filter((r) => r.regex && r.regex !== 'self' && (count[r.regex] = (count[r.regex] || 0) + 1) <= perPattern);
    const rest = pool.filter((r) => !fires.includes(r));
    return [...fires, ...rest].slice(0, Math.max(total, fires.length));
  };
  const picked = [...take(unique.filter((r) => !r.followup), requests), ...take(unique.filter((r) => r.followup), followups)];
  return picked.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

// Assigns each row split 'dev' or 'test' by unit (one session on one day), never splitting a unit: neighbouring
// turns share wording, so they must not sit on both sides. Largest units first, each to the smaller half.
function split(rows, seed = 10) {
  const size = new Map();
  for (const r of rows) size.set(r.unit, (size.get(r.unit) || 0) + 1);
  const units = shuffled([...size.keys()].sort(), rng(seed)).sort((a, b) => size.get(b) - size.get(a));
  const half = { dev: 0, test: 0 };
  const side = new Map();
  for (const u of units) {
    const to = half.dev <= half.test ? 'dev' : 'test';
    side.set(u, to);
    half[to] += size.get(u);
  }
  return rows.map((r) => ({ ...r, split: side.get(r.unit) }));
}

module.exports = { candidates, fired, sample, split, REQUEST_LABELS, FOLLOWUP_LABELS };
