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

module.exports = { candidates, fired, REQUEST_LABELS, FOLLOWUP_LABELS };
