'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PERMISSION } = require('../prefs/import');
const { redact } = require('../prefs/redact');

const DAY = 86400000;
const CHECK_IDS = ['advice-no-edits', 'only-named-files', 'no-ai-traces', 'no-emoji', 'exact-copy', 'check-cmd', 'typecheck', 'small-commits', 'commit-changes'];
const KINDS = new Set(['process', 'ui', 'code', 'git', 'output', 'communication']);

const home = () => process.env.BUC_HOME || path.join(os.homedir(), '.better-ultracore');
const file = (name) => path.join(home(), name);

// Current time in ms. BUC_NOW (an ISO date or epoch ms) pins it, for replay and as-of runs.
function clock() {
  const v = process.env.BUC_NOW;
  if (!v) return Date.now();
  const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(t) ? t : Date.now();
}

// True when a feature is switched off: BUC_OFF (comma list) or "off" in <root>/.claude/buc.json (array or comma list).
function off(name, root = process.cwd()) {
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  let conf = null;
  try { conf = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'buc.json'), 'utf8')); } catch { /* no config */ }
  return [...list(process.env.BUC_OFF), ...list(conf && conf.off)].includes(String(name).toLowerCase());
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  fs.mkdirSync(home(), { recursive: true });
  const tmp = `${file(name)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file(name));
}

const loadRules = () => readJson('rules.json', []);
const saveRules = (rules) => writeJson('rules.json', rules);

const inboxKey = (i) => crypto.createHash('sha1').update(`${i.session_id}\n${i.text}`).digest('hex');

// Appends entries not already in the inbox (same session and text); returns the number added.
function appendInbox(items) {
  const seen = new Set(readInbox().map(inboxKey));
  const fresh = items.filter((i) => !seen.has(inboxKey(i)) && seen.add(inboxKey(i)));
  if (!fresh.length) return 0;
  fs.mkdirSync(home(), { recursive: true });
  fs.appendFileSync(file('inbox.jsonl'), fresh.map((i) => `${JSON.stringify(i)}\n`).join(''));
  return fresh.length;
}

function readInbox() {
  try {
    return fs.readFileSync(file('inbox.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);

// Returns {rule} or {error}. Permission-expanding text is rejected, never stored.
const META_WORDS = new Set(['prompt', 'contains', 'names', 'everything', 'changes', 'adding', 'again', 'sure']);
const cleanKeywords = (list) => [...new Set(list.map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')).filter((k) => k.length >= 2 && !META_WORDS.has(k)))];

const ORIGINS = ['learn', 'habit', 'import', 'bump'];
const MAX_SOURCES = 200;
const sourceKey = (s) => `${s.session}\n${s.h}\n${s.origin || ''}`;

// Provenance entries {session, repo, ts, h, origin?: 'bump'}: where a rule was learned or re-observed. A bare hash is kept as {h}.
// h is store.hash of the correction; the text itself is never kept. Entries with neither a session nor a hash are dropped.
function cleanSources(list) {
  const out = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const o = typeof raw === 'string' ? { h: raw } : raw && typeof raw === 'object' ? raw : {};
    const t = typeof o.ts === 'number' ? o.ts : Date.parse(o.ts);
    const src = {
      session: typeof o.session === 'string' ? o.session.slice(0, 80) : '',
      repo: typeof o.repo === 'string' ? o.repo.slice(0, 80) : '',
      ts: Number.isFinite(t) ? new Date(t).toISOString() : '',
      h: /^[0-9a-f]{12}$/.test(o.h || '') ? o.h : '',
    };
    if (o.origin === 'bump') src.origin = 'bump';
    if (!src.session && !src.h) continue;
    if (!out.has(sourceKey(src))) out.set(sourceKey(src), src);
  }
  return [...out.values()].slice(-MAX_SOURCES);
}

function normalize(raw, now = clock()) {
  if (!raw || typeof raw !== 'object') return { error: 'not an object' };
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(raw.id || '')) return { error: 'bad id' };
  if (typeof raw.rule !== 'string' || !raw.rule.trim()) return { error: 'missing rule text' };
  const check = raw.check && typeof raw.check === 'object' ? raw.check : {};
  if (check.cmd && !CHECK_IDS.includes(check.cmd)) return { error: `unknown check ${check.cmd}` };
  const text = [raw.rule, check.question].filter(Boolean).join(' ');
  if (PERMISSION.test(text)) return { error: 'permission-expanding text' };
  const when = raw.when && typeof raw.when === 'object' ? raw.when : {};
  const rule = {
    id: raw.id,
    rule: redact(raw.rule.trim()).slice(0, 220),
    when: { keywords: cleanKeywords(strings(when.keywords)), paths: strings(when.paths), promptKinds: strings(when.promptKinds) },
    check: { ...(check.cmd && { cmd: check.cmd }), ...(typeof check.question === 'string' && { question: redact(check.question).slice(0, 160) }) },
    kind: KINDS.has(raw.kind) ? raw.kind : 'process',
    count: Number.isFinite(raw.count) ? raw.count : 1,
    last_seen: raw.last_seen || new Date(now).toISOString(),
    violations: Number.isFinite(raw.violations) ? raw.violations : 0,
    pinned: Boolean(raw.pinned),
  };
  if (raw.last_violation) rule.last_violation = raw.last_violation;
  const sources = cleanSources(raw.sources);
  if (sources.length) rule.sources = sources;
  rule.origin = ORIGINS.includes(raw.origin) && raw.origin !== 'bump' ? raw.origin : sources.some((x) => !x.origin) ? 'learn' : 'import';
  const repos = strings(raw.scope && raw.scope.repos);
  if (repos.length) rule.scope = { repos: [...new Set(repos)] };
  const { keywords, paths, promptKinds } = rule.when;
  if (!keywords.length && !paths.length && !promptKinds.length) return { error: 'no trigger in when' };
  return { rule };
}

// With a repo that has stats, weights by that repo's hits and misses.
function score(rule, now = clock(), repo) {
  const base = rule.count * 0.5 ** ((now - Date.parse(rule.last_seen)) / (60 * DAY));
  const s = repo && rule.byRepo && rule.byRepo[repo];
  return s ? base * (1 + s.hits) / (1 + s.hits + 2 * s.misses) : base;
}

// Rules with score < 1 and no violation in 90 days leave the live set unless pinned.
function decay(rules, now = clock()) {
  const stale = (r) => !r.pinned && score(r, now) < 1 && !(r.last_violation && now - Date.parse(r.last_violation) < 90 * DAY);
  return { keep: rules.filter((r) => !stale(r)), archived: rules.filter(stale) };
}

// Inbox entries by provenance hash: {h: {session, repo, ts, h}}. Entries queued before v10 have no h; it is derived from their text.
function inboxSources() {
  const out = {};
  for (const i of readInbox()) {
    const h = i.h || hash(i.text);
    if (!out[h]) out[h] = { session: String(i.session_id || ''), repo: i.repo || '', ts: i.ts || '', h };
  }
  return out;
}

// Validates and upserts by id (keeps the larger count, merges sources, keeps an existing scope and origin); returns {added, rejected}.
// A source given as a bare hash (what /buc learn clustering returns) is filled in from the inbox entry with that hash.
function importRules(list, now = clock()) {
  const rules = loadForWrite();
  if (!rules) return { added: [], rejected: [{ reason: 'rules.json is unreadable' }] };
  const added = [];
  const rejected = [];
  let known = null;
  const resolve = (s) => {
    const h = typeof s === 'string' ? s : s && typeof s === 'object' && !s.session && !s.ts ? s.h : null;
    if (!h) return s;
    known = known || inboxSources();
    return known[h] || s;
  };
  for (const raw of Array.isArray(list) ? list : []) {
    const { rule, error } = normalize(raw && Array.isArray(raw.sources) ? { ...raw, sources: raw.sources.map(resolve) } : raw, now);
    if (error) {
      rejected.push({ id: raw && raw.id, reason: error });
      continue;
    }
    const i = rules.findIndex((r) => r.id === rule.id);
    if (i >= 0) {
      const old = rules[i];
      const { scope, sources: fresh, ...rest } = rule;
      const sources = cleanSources([...(old.sources || []), ...(fresh || [])]);
      rules[i] = {
        ...rest, count: Math.max(rule.count, old.count), violations: old.violations, pinned: old.pinned || rule.pinned,
        origin: old.origin && !(old.origin === 'import' && rule.origin !== 'import') ? old.origin : rule.origin,
        ...(sources.length && { sources }), ...(old.scope && { scope: old.scope }),
        ...(old.bumped_sessions && { bumped_sessions: old.bumped_sessions }), ...(old.byRepo && { byRepo: old.byRepo }),
      };
    } else rules.push(rule);
    added.push(rule.id);
  }
  saveRules(rules);
  return { added, rejected };
}

// Moves decayed rules to rules.archive.json; returns the live set.
function sweep(now = clock()) {
  const { keep, archived } = decay(loadRules(), now);
  if (archived.length) {
    writeJson('rules.archive.json', [...readJson('rules.archive.json', []), ...archived]);
    saveRules(keep);
  }
  return keep;
}

// Rules for a read-modify-write; null when rules.json exists but does not parse (never overwrite it).
function loadForWrite() {
  if (!fs.existsSync(file('rules.json'))) return [];
  const rules = readJson('rules.json', null);
  return Array.isArray(rules) ? rules : null;
}

function update(ids, fn) {
  const rules = loadForWrite();
  if (!rules) return;
  for (const r of rules) if (ids.includes(r.id)) fn(r);
  saveRules(rules);
}

// hits: {ruleId: [sessionId]}. Bumps once per (rule, session); remembers the last 50 sessions per rule.
function bumpSessions(hits, now = clock()) {
  update(Object.keys(hits), (r) => {
    const done = r.bumped_sessions || [];
    const fresh = [...new Set(hits[r.id])].filter((s) => !done.includes(s));
    if (!fresh.length) return;
    r.count += fresh.length;
    r.last_seen = new Date(now).toISOString();
    r.bumped_sessions = [...done, ...fresh].slice(-50);
  });
}

const bump = (ids, now = clock()) => update(ids, (r) => { r.count += 1; r.last_seen = new Date(now).toISOString(); });
const violate = (ids, now = clock()) => update(ids, (r) => { r.violations += 1; r.last_violation = new Date(now).toISOString(); });

// Turn file (turn-<session>.json): written by the prompt hook, read and updated by the Stop and tool hooks, cleared when a turn has nothing to check.
// Existing fields: {session_id, cwd, root, prompt (redacted), kind, head, porcelain, rules: [{id, cmd}], checks: [id]}.
// v10 fields, all optional; a reader must treat a missing one as unknown:
//   intent     string   reading chosen at prompt time: 'EXACT' | 'FEATURE' | 'SWEEP' | 'SHOW' | 'SELF' | 'UNDO' | 'MISREAD' | 'HANDSOFF' | ''
//   ui         boolean  a UI prompt with a resolvable dev server; the agent was told to take a screenshot
//   toolCalls  number   tool calls so far this turn (hooks/track.js adds to it; a new prompt resets it)
//   shotAt     number   epoch ms of the last buc-shot this turn, 0 or absent when none
//   prevFiles  object   the previous turn's {head, files} entry `files`, copied from the last-turn record, for the undo check
// Use patchTurn to change single fields; writeTurn replaces the whole file.
const turnFile = (sessionId) => `turn-${String(sessionId).replace(/[^\w-]/g, '')}.json`;
const writeTurn = (sessionId, turn) => writeJson(turnFile(sessionId), turn);
const readTurn = (sessionId) => readJson(turnFile(sessionId), null);
const clearTurn = (sessionId) => { try { fs.unlinkSync(file(turnFile(sessionId))); } catch { /* already gone */ } };
// Merges fields into the turn file and returns the result. With no turn file it writes {session_id, ...patch}, so a reader must not assume `checks` exists.
function patchTurn(sessionId, patch) {
  const turn = { ...(readTurn(sessionId) || { session_id: sessionId }), ...patch };
  writeTurn(sessionId, turn);
  return turn;
}

const lastTurnFile = (sessionId) => `lastturn-${String(sessionId).replace(/[^\w-]/g, '')}.json`;

// Tiny per-session record of the previous turn: {rules: [matched rule ids], repo, ts, head?, files?}.
// head is HEAD when that turn began; files maps each repo-relative path the turn changed to its content hash before the turn (null when it did not exist).
// A call with `rules` starts a new record (the prompt hook). A call without `rules` (the Stop hook adding {head, files}) merges into the stored one.
function saveLastTurn(sessionId, turn) {
  const prev = (turn.rules === undefined && loadLastTurn(sessionId)) || {};
  const rec = { rules: turn.rules || prev.rules || [], repo: turn.repo || prev.repo || '', ts: turn.ts || prev.ts || clock() };
  const head = turn.head !== undefined ? turn.head : prev.head;
  const files = turn.files !== undefined ? turn.files : prev.files;
  if (head !== undefined) rec.head = head;
  if (files !== undefined) rec.files = files;
  writeJson(lastTurnFile(sessionId), rec);
}

const loadLastTurn = (sessionId) => readJson(lastTurnFile(sessionId), null);

// Per-repo outcome of the rules shown on a turn: rule.byRepo[repo] = {hits, misses}.
function recordOutcome(ids, repo, miss) {
  if (!repo) return;
  update(ids, (r) => {
    r.byRepo = r.byRepo || {};
    const s = r.byRepo[repo] || { hits: 0, misses: 0 };
    s[miss ? 'misses' : 'hits'] += 1;
    r.byRepo[repo] = s;
  });
}

// Provenance hash of a correction: first 12 hex of sha1 of the redacted, trimmed text. Rules store this, never the text.
const hash = (text) => crypto.createHash('sha1').update(redact(String(text || '').trim())).digest('hex').slice(0, 12);

// Per-repo state in repos.json, keyed by repoKey: {handsOff?: 'on'|'off'|'auto', events: [{e, s, ts}]}.
// Events are names only (e: event, s: session id, ts: ISO time); no prompt text is stored.
function repoState(repo) {
  const all = readJson('repos.json', {});
  const st = all && typeof all === 'object' && all[repo] && typeof all[repo] === 'object' ? all[repo] : {};
  return { ...st, events: Array.isArray(st.events) ? st.events : [] };
}

const MAX_REPO_EVENTS = 400;
const iso = (ts) => new Date(typeof ts === 'number' ? ts : Date.parse(ts) || clock()).toISOString();

// Read-modify-write of one repo's state; leaves a repos.json that does not parse untouched.
function updateRepo(repo, fn) {
  if (!repo) return null;
  const all = readJson('repos.json', fs.existsSync(file('repos.json')) ? null : {});
  if (!all || typeof all !== 'object' || Array.isArray(all)) return null;
  const st = repoState(repo);
  fn(st);
  all[repo] = st;
  writeJson('repos.json', all);
  return st;
}

// Appends one named event for a repo and keeps the newest 400. Returns the repo state, or null when nothing was written.
function recordRepo(repo, event, sessionId, ts = clock()) {
  if (!event) return null;
  return updateRepo(repo, (st) => {
    st.events = [...st.events, { e: String(event), s: String(sessionId || ''), ts: iso(ts) }].slice(-MAX_REPO_EVENTS);
  });
}

// Sets plain fields of a repo's state (today: handsOff); an undefined value removes the field. Events are kept.
function setRepo(repo, patch) {
  return updateRepo(repo, (st) => {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'events') continue;
      if (v === undefined) delete st[k];
      else st[k] = v;
    }
  });
}

module.exports = { CHECK_IDS, home, now: clock, off, hash, repoState, recordRepo, setRepo, loadRules, saveRules, appendInbox, readInbox, normalize, score, decay, importRules, sweep, bump, bumpSessions, violate, writeTurn, readTurn, patchTurn, clearTurn, saveLastTurn, loadLastTurn, recordOutcome };
