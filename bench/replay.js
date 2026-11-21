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
        const byId = new Map(store.loadRules().map((r) => [r.id, r]));
        const rules = (last && Array.isArray(last.rules) ? last.rules : []).map((id) => ({ id, rule: (byId.get(id) || {}).rule || '', origin: (byId.get(id) || {}).origin || '' }));
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

const share = (n, d) => (d ? n / d : null);

// Coverage of a list of corrections. `covered` counts those whose request was shown a rule the correction would
// bump; `recurring` those that mention any rule the store already had, shown or not. confirmed (optional) is a
// set of indexes into the list that a judge agreed on.
function coverage(list, confirmed = null) {
  const covered = list.filter((c) => c.covered.length).length;
  const recurring = list.filter((c) => c.would_bump.length).length;
  // A habit the user stated outright is not something the loop learned; covered_learned leaves those out.
  const learned = list.filter((c) => c.covered.some((r) => r.origin !== 'habit')).length;
  const out = { corrections: list.length, recurring, covered, covered_learned: learned, coverage: share(covered, list.length), of_recurring: share(covered, recurring) };
  if (confirmed) {
    out.confirmed = list.filter((c) => confirmed.has(c)).length;
    out.confirmed_coverage = share(out.confirmed, list.length);
  }
  return out;
}

// The replay's numbers, with no text in them.
// confirmed: Set of corrections (objects of run.corrections) a judge said the shown rule really addresses.
// relevant: {sampled, yes} from a judge over sampled (request, shown rule) pairs: injection precision.
function metrics(run, { confirmed = null, relevant = null } = {}) {
  const c = run.corrections;
  const half = Math.ceil(c.length / 2);
  const instances = run.injections.reduce((n, x) => n + x.rules.length, 0);
  const regretted = new Set(c.flatMap((x) => x.regret));
  return {
    sessions: run.sessions, turns: run.turns, rules: run.rules.length, archived: run.archived.length, cluster_calls: run.cluster_calls,
    coverage: coverage(c, confirmed), first_half: coverage(c.slice(0, half), confirmed), second_half: coverage(c.slice(half), confirmed),
    injection: {
      turns_with_rules: run.injections.length, share_of_turns: share(run.injections.length, run.turns), rule_instances: instances,
      learned_instances: run.injections.reduce((n, x) => n + x.rules.filter((r) => r.origin !== 'habit').length, 0),
      // Without a judge the only offline signal: shown rules that the next correction went on to mention.
      followed_by_matching_correction: c.reduce((n, x) => n + x.covered.length, 0),
      ...(relevant && { judged: relevant.sampled, relevant: relevant.yes, precision: share(relevant.yes, relevant.sampled) }),
    },
    decay_regret: { archived: run.archived.length, regretted_rules: regretted.size, corrections: c.filter((x) => x.regret.length).length },
  };
}

const clip = (text, n = 400) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);

const CLUSTER = `Below are short corrections a user typed to a coding assistant, each with a hash "h", and the standing rules already learned from earlier ones.
Cluster the corrections into at most 15 standing rules that would have prevented them. Reuse an existing rule's id when a correction teaches the same lesson. Leave out corrections that are one-off, about one specific bug, or teach nothing reusable.
Return a JSON array. Each rule is {"id": "lowercase-slug", "rule": "an instruction of at most 25 words", "when": {"keywords": ["3 to 8 single lowercase words likely to appear in a future request where the rule applies, or in a correction that breaks it"]}, "kind": "process|ui|code|git|output|communication", "sources": ["the h of every correction it came from, copied exactly"]}.`;

// A cluster(candidates, rules) for replay() that asks a model through bench/ask.js (cached, capped). opts go to ask().
function modelCluster(opts, askFn = require('./ask').ask) {
  const { jsonIn } = require('./ask');
  return (candidates, rules) => {
    const body = { rules: rules.map((r) => ({ id: r.id, rule: r.rule })), corrections: candidates.map((c) => ({ h: c.h, text: clip(c.text, 240) })) };
    const got = jsonIn(askFn(`${CLUSTER}\n\n${JSON.stringify(body)}`, opts).text);
    return Array.isArray(got) ? got : [];
  };
}

// Yes/no answers from a model for a list of items, asked in batches. Returns one entry per item: true, false, or
// null when the model gave no answer for it (or the budget ran out first).
function judge(items, question, opts, { size = 30, askFn = require('./ask').ask } = {}) {
  const { jsonIn } = require('./ask');
  const out = new Array(items.length).fill(null);
  for (let at = 0; at < items.length; at += size) {
    const batch = items.slice(at, at + size).map((x, k) => ({ i: at + k, ...x }));
    let got = null;
    try { got = jsonIn(askFn(`${question}\nAnswer for every item. Return a JSON array of {"i": number, "yes": true or false}.\n\n${JSON.stringify(batch)}`, opts).text); } catch (e) { if (e.code === 'BUDGET') break; }
    for (const g of Array.isArray(got) ? got : []) if (g && Number.isInteger(g.i) && g.i >= at && g.i < at + batch.length) out[g.i] = g.yes === true;
  }
  return out;
}

const Q_CONFIRM = 'Each item is a request a user typed to a coding assistant, the correction the user typed after the assistant\'s attempt, and a standing rule the assistant had been shown with the request. Say yes when the correction complains about the very thing the rule tells the assistant to do or avoid, so that obeying the rule would have avoided the correction.';
const Q_RELEVANT = 'Each item is a request a user typed to a coding assistant and a standing rule the assistant was shown with it. Say yes when the rule applies to this request: following it could change how the request should be carried out. Say no when the rule is about something the request does not involve.';

// The corrections whose shown rule a judge agrees would have avoided them: metrics({confirmed}).
function confirmCoverage(run, opts, extra) {
  const pairs = run.corrections.flatMap((c) => c.covered.map((r) => ({ c, item: { request: clip(c.request), correction: clip(c.text), rule: r.rule } })));
  const yes = judge(pairs.map((p) => p.item), Q_CONFIRM, opts, extra);
  return new Set(pairs.filter((p, i) => yes[i]).map((p) => p.c));
}

// Injection precision on a seeded sample of (request, shown learned rule) pairs: metrics({relevant}). Stated habits
// are pinned by the user and left out.
function samplePrecision(run, opts, { n = 120, seed = 10, ...extra } = {}) {
  const all = run.injections.flatMap((x) => x.rules.filter((r) => r.origin !== 'habit').map((r) => ({ request: clip(x.prompt), rule: r.rule })));
  const next = require('./stats').rng(seed);
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  const answers = judge(all.slice(0, n), Q_RELEVANT, opts, extra).filter((v) => v !== null);
  return { sampled: answers.length, yes: answers.filter(Boolean).length, of: all.length };
}

const pct = (x) => (x === null || x === undefined ? '-' : `${(100 * x).toFixed(0)}%`);

// The metrics of the three runs as a short text table.
function summary(result) {
  const row = (name, m) => `| ${name} | ${m.coverage.corrections} | ${m.coverage.recurring} | ${m.coverage.covered} (${pct(m.coverage.coverage)}) | ${m.coverage.covered_learned} | ${m.coverage.confirmed ?? '-'} (${pct(m.coverage.confirmed_coverage)}) | ${pct(m.first_half.coverage)} | ${pct(m.second_half.coverage)} | ${m.rules} | ${m.decay_regret.regretted_rules} of ${m.decay_regret.archived} |`;
  const inj = result.learn.injection;
  const day = result.by_day;
  return [
    `Replay: ${result.learn.sessions} sessions, ${result.learn.turns} user turns, ${result.learn.cluster_calls} clustering steps`,
    '',
    '| run | corrections | mention a known rule | covered | by a learned rule | judge-confirmed | first half | second half | rules at end | archived rules a later correction matched |',
    '|---|---|---|---|---|---|---|---|---|---|',
    row('learning', result.learn), row('learning, no per-repo stats', result.no_byrepo), row('no learning', result.no_learn),
    ...(day ? [row('by day: learning', day.learn), row('by day: learning, no per-repo stats', day.no_byrepo), row('by day: no learning', day.no_learn)] : []),
    '',
    `Injection: rules shown on ${inj.turns_with_rules} of ${result.learn.turns} turns (${inj.rule_instances} rule showings, ${inj.learned_instances} of learned rules); learned showings judged relevant ${inj.relevant ?? '-'} of ${inj.judged ?? '-'} sampled (${pct(inj.precision)})`,
    ...(day ? [`By day (${day.learn.sessions} units, ${day.learn.cluster_calls} clustering steps): rules shown on ${day.learn.injection.turns_with_rules} turns (${day.learn.injection.learned_instances} showings of learned rules); judged relevant ${day.learn.injection.relevant ?? '-'} of ${day.learn.injection.judged ?? '-'} sampled (${pct(day.learn.injection.precision)})`] : []),
    `Model spend: $${result.spent_usd.toFixed(3)}`,
  ].join('\n');
}

// CLI: node bench/replay.js --cache <dir outside the repo> [--projects-root dir] [--every 5] [--cap 3] [--model haiku]
//      [--sample 120] [--seed 10] [--out file]
// Three replays: learning, learning without per-repo stats, and no learning; then the same three with every
// multi-day session split into one unit per day, so learning can happen inside a long session. Prints the summary;
// writes the metrics (numbers only) to --out, by default <cache>/replay-metrics.json. Model answers are cached
// under --cache.
function main(argv) {
  const f = { every: '5', cap: '3', model: 'haiku', sample: '120', seed: '10' };
  for (let i = 0; i < argv.length; i++) f[argv[i].replace(/^--/, '')] = argv[++i];
  if (!f.cache) throw new Error('usage: replay.js --cache <dir outside the repo> [--projects-root dir] [--every 5] [--cap 3] [--model haiku]');
  const { outside, spent } = require('./ask');
  const { allSessions } = require('./transcripts');
  const cacheDir = outside(f.cache);
  const sessions = f['projects-root'] ? allSessions(f['projects-root']) : allSessions();
  const opts = { cacheDir, label: 'replay', cap: parseFloat(f.cap), model: f.model };
  // Each replay starts from an empty store in a fresh folder; earlier ones are left in place under the cache dir.
  fs.mkdirSync(cacheDir, { recursive: true });
  const homes = fs.mkdtempSync(path.join(cacheDir, 'replay-home-'));
  const three = (units, tag) => {
    const go = (name, o) => replay(units, { home: path.join(homes, tag + name), every: parseInt(f.every, 10), log: (m) => console.error(`[${tag}${name}] ${m}`), ...o });
    const learned = go('learn', { cluster: modelCluster(opts) });
    const flat = go('no-byrepo', { cluster: modelCluster(opts), byRepo: false });
    const none = go('no-learn', { learn: false });
    return {
      learn: metrics(learned, { confirmed: confirmCoverage(learned, opts), relevant: samplePrecision(learned, opts, { n: parseInt(f.sample, 10), seed: parseInt(f.seed, 10) }) }),
      no_byrepo: metrics(flat, { confirmed: confirmCoverage(flat, opts) }),
      no_learn: metrics(none),
    };
  };
  const result = three(sessions, '');
  result.by_day = three(require('./transcripts').byDay(sessions, path.join(homes, 'units')), 'day-');
  result.spent_usd = spent(cacheDir, 'replay');
  const out = f.out || path.join(cacheDir, 'replay-metrics.json');
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(summary(result));
  console.error(`wrote ${out}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { summary, modelCluster, judge, confirmCoverage, samplePrecision, coverage, metrics, replay, wouldBump, stripByRepo, freshCandidates, usable };
