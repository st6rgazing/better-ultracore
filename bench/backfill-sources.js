#!/usr/bin/env node
'use strict';
// Maps existing rules to the corrections that may have sourced them, by keyword. Over-inclusive on purpose:
// a rule tied to too many corrections is only ever excluded from more held-out runs, never fewer.
// Emits a JSON mapping {rule id: [{session, repo, ts, h}]}. It reads rules.json and never writes it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { redact } = require('../lib/prefs/redact');
const { parseSession, transcripts, repoOf, minerVisible, keywordHits } = require('./mine-cases');

// Provenance of one correction turn: no text, only the first 12 hex of the sha1 of its redacted text.
function sourceOf(turn) {
  return {
    session: turn.session,
    repo: repoOf(turn.cwd) || turn.cwd || null,
    ts: turn.ts,
    h: crypto.createHash('sha1').update(redact(turn.text.trim())).digest('hex').slice(0, 12),
  };
}

// Every correction the rule miner could have seen that carries at least `min` keywords of a rule becomes a
// source of that rule. Rules without keywords or without a match map to an empty list.
function backfill(rules, turns, { min = 1 } = {}) {
  const out = {};
  for (const r of rules) {
    const seen = new Set();
    out[r.id] = [];
    for (const t of turns) {
      if (!minerVisible(t.text) || keywordHits(t.text, [r]).hits < min) continue;
      const s = sourceOf(t);
      const key = `${s.session}|${s.h}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out[r.id].push(s);
    }
    out[r.id].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }
  return out;
}

module.exports = { sourceOf, backfill };
