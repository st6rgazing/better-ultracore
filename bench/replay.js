#!/usr/bin/env node
'use strict';
// Longitudinal replay: runs the user's real sessions, oldest first, through the prompt and session-end hooks
// against a rule store that only knows the earlier sessions. Offline: no agent runs, the source repos are only
// read. It measures whether a learned rule was shown before the correction it came from recurs, not whether the
// agent would have obeyed it. See bench/README.md.
const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/rules/store');
const inject = require('../hooks/inject');
const sessionEnd = require('../hooks/session-end');
const { correctiveTurns } = require('../lib/rules/mine');
const { redact } = require('../lib/prefs/redact');

// Ids of the rules a correction mentions by keyword: the same any-keyword match hooks/session-end.js bumps on.
function wouldBump(rules, text) {
  const hit = (r) => r.when.keywords.map((k) => k.replace(/\W/g, '')).filter(Boolean).some((w) => new RegExp(`\\b${w}\\b`, 'i').test(text));
  return rules.filter(hit).map((r) => r.id);
}

// Removes per-repo hit and miss stats from the stored rules, for the run that ranks without them.
function stripByRepo() {
  const rules = store.loadRules();
  if (rules.some((r) => r.byRepo)) store.saveRules(rules.map(({ byRepo: _drop, ...r }) => r));
}

const readArchive = () => { try { return JSON.parse(fs.readFileSync(path.join(store.home(), 'rules.archive.json'), 'utf8')); } catch { return []; } };

// Inbox candidates not yet handed to clustering, one per hash.
function freshCandidates(done) {
  const out = new Map();
  for (const i of store.readInbox()) {
    const h = i.h || store.hash(i.text);
    if (!done.has(h) && !out.has(h)) out.set(h, { h, text: i.text, repo: i.repo || '' });
  }
  return [...out.values()];
}

// Keeps what a clustering step may store: rules whose sources are hashes of real inbox entries; count is the number of sources.
function usable(list, known) {
  return (Array.isArray(list) ? list : []).map((r) => {
    const sources = [...new Set((r && Array.isArray(r.sources) ? r.sources : []).map((s) => (typeof s === 'string' ? s : s && s.h)).filter((h) => known.has(h)))];
    return sources.length ? { ...r, sources, count: sources.length, pinned: false } : null;
  }).filter(Boolean);
}

// Replays sessions (from bench/transcripts.js allSessions, oldest first) into the empty store at `home`.
// Per user turn: BUC_NOW is the turn's time and the prompt hook runs. Per session: the session-end hook queues its
// corrections and bumps rules. Every `every` sessions decayed rules are archived and `cluster(candidates, rules)`
// returns rules to import, auto-approved in replay only. learn: false never clusters, so no rule is ever learned.
// byRepo: false ranks without per-repo stats.
// Returns {sessions, turns, corrections, injections, rules, archived, cluster_calls}. A correction is a turn the rule
// miner would queue, with the request before it: {session, idx, ts, request, text, injected, would_bump, covered,
// regret}. covered lists the rules that were shown on the request and that the correction would bump.
function replay(sessions, { home, learn = true, every = 5, cluster = null, byRepo = true, log = () => {} } = {}) {
  const saved = { BUC_HOME: process.env.BUC_HOME, BUC_NOW: process.env.BUC_NOW };
  fs.mkdirSync(home, { recursive: true });
  process.env.BUC_HOME = home;
  const corrections = [];
  const injections = [];
  const done = new Set();
  let calls = 0;
  let turns = 0;
  let learning = learn && typeof cluster === 'function';
  try {
    sessions.forEach((s, i) => {
      const corrective = new Set(correctiveTurns(s.file).map((c) => c.h));
      let prev = null;
      for (const t of s.turns) {
        turns += 1;
        process.env.BUC_NOW = t.ts || s.start;
        if (!byRepo) stripByRepo();
        if (prev && corrective.has(store.hash(redact(t.text.trim())))) {
          const live = store.loadRules();
          const ids = new Set(live.map((r) => r.id));
          const bump = wouldBump(live, t.text);
          const shown = new Set(prev.rules.map((r) => r.id));
          corrections.push({
            session: s.session, idx: t.idx, ts: t.ts, request: prev.text, text: t.text, injected: [...shown], would_bump: bump,
            covered: prev.rules.filter((r) => bump.includes(r.id)),
            regret: wouldBump(readArchive().filter((r) => r && r.when && !ids.has(r.id)), t.text),
          });
        }
        inject.run({ prompt: t.text, cwd: t.cwd || s.cwd, session_id: s.session, transcript_path: '' });
        const last = store.loadLastTurn(s.session);
        const text = new Map(store.loadRules().map((r) => [r.id, r.rule]));
        const rules = (last && Array.isArray(last.rules) ? last.rules : []).map((id) => ({ id, rule: text.get(id) || '' }));
        if (rules.length) injections.push({ session: s.session, idx: t.idx, ts: t.ts, prompt: t.text, rules });
        prev = { text: t.text, rules };
      }
      process.env.BUC_NOW = s.end || s.start;
      sessionEnd.run({ transcript_path: s.file });
      if ((i + 1) % every !== 0) return;
      // The live store only archives decayed rules when the user reviews them (`buc rules list`); replay reviews here.
      store.sweep();
      if (!learning) return;
      const fresh = freshCandidates(done);
      if (!fresh.length) return;
      try {
        const known = new Set(store.readInbox().map((x) => x.h || store.hash(x.text)));
        const res = store.importRules(usable(cluster(fresh, store.loadRules()), known));
        calls += 1;
        fresh.forEach((c) => done.add(c.h));
        log(`after session ${i + 1}: ${fresh.length} candidates, ${res.added.length} rules stored, ${res.rejected.length} rejected`);
      } catch (e) {
        log(`after session ${i + 1}: clustering failed: ${e.message}`);
        if (e.code === 'BUDGET') learning = false;
      }
    });
    return {
      sessions: sessions.length, turns, corrections, injections, cluster_calls: calls,
      rules: store.loadRules().map((r) => ({ id: r.id, count: r.count, origin: r.origin })), archived: readArchive().map((r) => r.id),
    };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

module.exports = { replay, wouldBump, stripByRepo, freshCandidates, usable };
