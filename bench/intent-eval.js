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
  return c ? { followup: true, pattern: c } : { followup: false, pattern: intent.readIntent(text, { kind: promptKind(text), mode: 'self', retired: true }).pattern };
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

const LABEL = `You label turns a user typed to a coding assistant, to build an evaluation set. Each item has "kind" (request or followup), "text", for a followup the "previous_request", and "after": the number of files the assistant then edited, how many were UI files, and "user_then", how the user's next turn reacted (still, misread, undo-show or overshoot: a correction of that kind; cue: some corrective wording; none: no correction; end: last turn). Use "after" as a hint about what the user wanted, never as the label itself.

Label a request with what the user wanted:
- exact: a named thing takes a stated value or state, or a named thing is nudged by a small degree; the right response is a minimal, literal edit.
- feature: build, add or change behaviour that has to be wired into the app.
- sweep: the same change at every occurrence across the project.
- vague: names a screen or area to fix or improve without saying what is wrong.
- show: wants an explanation, advice, review or steps; no file edits wanted.
- other: none of these (deploy, commit or push, a status question, small talk, pasted output with no ask, "continue").

Label a followup with how it reacts to the assistant's last change:
- still: the problem is still there, the change did not work.
- misread: the assistant did the wrong thing or misunderstood; a different reading is wanted.
- undo-show: undo the change and show or tell instead.
- overshoot: the right direction, but too much or too far.
- new-request: not a correction: a next request, an approval or a question.

Return a JSON array with one {"i": number, "gold": "label"} per item.`;

const clip = (text, n) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Pre-labels rows with a model through bench/ask.js (cached and capped; opts go to ask()). The model never sees
// which pattern fired. Returns the rows with `gold` (null when it gave no valid label, or the budget ran out) and
// `labelled_by`.
function label(rows, opts, { askFn = require('./ask').ask, size = 30 } = {}) {
  const { jsonIn } = require('./ask');
  const out = rows.map((r) => ({ ...r, gold: null }));
  for (let at = 0; at < rows.length; at += size) {
    const items = rows.slice(at, at + size).map((r, k) => ({
      i: at + k, kind: r.followup ? 'followup' : 'request', text: clip(r.prompt, 600), ...(r.followup && { previous_request: clip(r.prev, 300) }),
      after: { files_edited: r.evidence.files, ui_files: r.evidence.ui_files, user_then: r.evidence.next },
    }));
    let got = null;
    try { got = jsonIn(askFn(`${LABEL}\n\n${JSON.stringify(items)}`, opts).text); } catch (e) { if (e.code === 'BUDGET') break; }
    for (const g of Array.isArray(got) ? got : []) {
      const row = g && Number.isInteger(g.i) && g.i >= at && g.i < at + items.length ? out[g.i] : null;
      if (row && (row.followup ? FOLLOWUP_LABELS : REQUEST_LABELS).includes(g.gold)) Object.assign(row, { gold: g.gold, labelled_by: opts.model || 'model' });
    }
  }
  return out;
}

const GATE = { precision: 0.9, fires: 8 };

// Per-pattern precision of the labelled rows via intent.scorePatterns, with the gate from lib/intent.js: a pattern
// keeps its fixed line only with precision at least 0.9 on at least 8 fires. Returns [{pattern, fires, correct,
// precision, gated, pass, wrong}]; `self` and regex-mode patterns have no gold and are not gated.
function gate(rows, { mode = 'self' } = {}) {
  const scored = intent.scorePatterns(rows.filter((r) => r.gold), { mode });
  const gated = new Set([...intent.PRECISE.map((p) => p.id), 'still', 'overshoot', 'undo-show', 'misread']);
  const order = [...gated, ...Object.keys(scored).filter((k) => !gated.has(k))];
  return order.map((pattern) => {
    const s = scored[pattern] || { fires: 0, correct: 0, precision: null, wrong: [] };
    const judged = mode !== 'regex' && gated.has(pattern);
    return { pattern, fires: s.fires, correct: s.correct, precision: s.precision, gated: judged, pass: judged ? s.fires >= GATE.fires && s.precision >= GATE.precision : null, wrong: s.wrong };
  }).filter((x) => x.gated || x.fires);
}

// The gate results as a table, with the ids of the rows each pattern got wrong: those are the ones to review by hand.
function table(results) {
  const out = ['| pattern | fires | correct | precision | gate (0.9 on 8 fires) |', '|---|---|---|---|---|'];
  for (const r of results) {
    const verdict = !r.gated ? 'not gated' : r.pass ? 'PASS' : r.fires < GATE.fires ? `FAIL (${r.fires} fires)` : 'FAIL';
    out.push(`| ${r.pattern} | ${r.fires} | ${r.gated ? r.correct : '-'} | ${r.precision === null ? '-' : r.precision.toFixed(2)} | ${verdict} |`);
  }
  const wrong = results.filter((r) => r.gated && r.wrong.length).map((r) => `${r.pattern}: ${r.wrong.join(', ')}`);
  if (wrong.length) out.push('', 'Rows to review (the pattern fired, the label disagrees):', ...wrong);
  return out.join('\n');
}

// True when a file may hold private text: it is outside any git work tree, or git ignores it there.
function privatePath(file) {
  const { spawnSync } = require('node:child_process');
  const full = path.resolve(file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (spawnSync('git', ['-C', path.dirname(full), 'rev-parse', '--show-toplevel']).status !== 0) return true;
  return spawnSync('git', ['-C', path.dirname(full), 'check-ignore', '-q', full]).status === 0;
}

const readRows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const tally = (rows, key) => Object.entries(rows.reduce((n, r) => ({ ...n, [key(r)]: (n[key(r)] || 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ');

// build: node bench/intent-eval.js build --out <private .jsonl> --cache <dir outside the repo> [--projects-root dir]
//          [--requests 200] [--followups 60] [--per-pattern 24] [--seed 10] [--cap 5] [--model sonnet] [--label off]
//        Samples real turns, pre-labels them with one offline model pass and writes one JSON row per line.
// score: node bench/intent-eval.js score --file <.jsonl> [--split dev|test|all] [--mode self|regex]
//        Prints per-pattern precision and the gate. The dev half is the default; keep the test half for the end.
function main(argv) {
  const [cmd, ...rest] = argv;
  const f = { requests: '200', followups: '60', 'per-pattern': '24', seed: '10', cap: '5', model: 'sonnet', split: 'dev', mode: 'self' };
  for (let i = 0; i < rest.length; i++) f[rest[i].replace(/^--/, '')] = rest[++i];
  if (cmd === 'build') {
    if (!f.out || !f.cache) throw new Error('usage: intent-eval.js build --out <private .jsonl> --cache <dir outside the repo>');
    if (!privatePath(f.out)) throw new Error(`refusing to write private prompts to a tracked path: ${f.out}`);
    const { outside, spent } = require('./ask');
    const { allSessions } = require('./transcripts');
    const cacheDir = outside(f.cache);
    const seed = parseInt(f.seed, 10);
    const sessions = f['projects-root'] ? allSessions(f['projects-root']) : allSessions();
    const picked = split(sample(candidates(sessions), { requests: parseInt(f.requests, 10), followups: parseInt(f.followups, 10), perPattern: parseInt(f['per-pattern'], 10), seed }), seed);
    const rows = f.label === 'off' ? picked.map((r) => ({ ...r, gold: null })) : label(picked, { cacheDir, label: 'intent-eval', cap: parseFloat(f.cap), model: f.model });
    fs.writeFileSync(f.out, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    console.log(`wrote ${rows.length} rows to ${f.out}: ${tally(rows, (r) => (r.followup ? 'followups' : 'requests'))}; ${tally(rows, (r) => r.split)}; labelled ${rows.filter((r) => r.gold).length}; model spend $${spent(cacheDir, 'intent-eval').toFixed(3)}`);
    return;
  }
  if (cmd === 'score') {
    if (!f.file) throw new Error('usage: intent-eval.js score --file <.jsonl> [--split dev|test|all] [--mode self|regex]');
    const rows = readRows(f.file).filter((r) => f.split === 'all' || !r.split || r.split === f.split);
    const labelled = rows.filter((r) => r.gold);
    console.log(`${f.split} rows: ${rows.length}, labelled ${labelled.length}; labels: ${tally(labelled, (r) => r.gold)}`);
    console.log('');
    console.log(table(gate(rows, { mode: f.mode })));
    return;
  }
  throw new Error('usage: intent-eval.js build|score ...');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { candidates, fired, sample, split, label, gate, table, privatePath, GATE, REQUEST_LABELS, FOLLOWUP_LABELS };
