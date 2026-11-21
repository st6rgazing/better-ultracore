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

function normalize(raw, now = Date.now()) {
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
  const { keywords, paths, promptKinds } = rule.when;
  if (!keywords.length && !paths.length && !promptKinds.length) return { error: 'no trigger in when' };
  return { rule };
}

// With a repo that has stats, weights by that repo's hits and misses.
function score(rule, now = Date.now(), repo) {
  const base = rule.count * 0.5 ** ((now - Date.parse(rule.last_seen)) / (60 * DAY));
  const s = repo && rule.byRepo && rule.byRepo[repo];
  return s ? base * (1 + s.hits) / (1 + s.hits + 2 * s.misses) : base;
}

// Rules with score < 1 and no violation in 90 days leave the live set unless pinned.
function decay(rules, now = Date.now()) {
  const stale = (r) => !r.pinned && score(r, now) < 1 && !(r.last_violation && now - Date.parse(r.last_violation) < 90 * DAY);
  return { keep: rules.filter((r) => !stale(r)), archived: rules.filter(stale) };
}

// Validates and upserts by id (keeps the larger count); returns {added, rejected}.
function importRules(list, now = Date.now()) {
  const rules = loadForWrite();
  if (!rules) return { added: [], rejected: [{ reason: 'rules.json is unreadable' }] };
  const added = [];
  const rejected = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const { rule, error } = normalize(raw, now);
    if (error) {
      rejected.push({ id: raw && raw.id, reason: error });
      continue;
    }
    const i = rules.findIndex((r) => r.id === rule.id);
    if (i >= 0) rules[i] = { ...rule, count: Math.max(rule.count, rules[i].count), violations: rules[i].violations, ...(rules[i].bumped_sessions && { bumped_sessions: rules[i].bumped_sessions }), ...(rules[i].byRepo && { byRepo: rules[i].byRepo }), pinned: rules[i].pinned || rule.pinned };
    else rules.push(rule);
    added.push(rule.id);
  }
  saveRules(rules);
  return { added, rejected };
}

// Moves decayed rules to rules.archive.json; returns the live set.
function sweep(now = Date.now()) {
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
function bumpSessions(hits, now = Date.now()) {
  update(Object.keys(hits), (r) => {
    const done = r.bumped_sessions || [];
    const fresh = [...new Set(hits[r.id])].filter((s) => !done.includes(s));
    if (!fresh.length) return;
    r.count += fresh.length;
    r.last_seen = new Date(now).toISOString();
    r.bumped_sessions = [...done, ...fresh].slice(-50);
  });
}

const bump = (ids, now = Date.now()) => update(ids, (r) => { r.count += 1; r.last_seen = new Date(now).toISOString(); });
const violate = (ids, now = Date.now()) => update(ids, (r) => { r.violations += 1; r.last_violation = new Date(now).toISOString(); });

const turnFile = (sessionId) => `turn-${String(sessionId).replace(/[^\w-]/g, '')}.json`;
const writeTurn = (sessionId, turn) => writeJson(turnFile(sessionId), turn);
const readTurn = (sessionId) => readJson(turnFile(sessionId), null);
const clearTurn = (sessionId) => { try { fs.unlinkSync(file(turnFile(sessionId))); } catch { /* already gone */ } };

const lastTurnFile = (sessionId) => `lastturn-${String(sessionId).replace(/[^\w-]/g, '')}.json`;

// Tiny per-session record of the previous turn: {rules: [matched rule ids], repo, ts}.
const saveLastTurn = (sessionId, turn) => writeJson(lastTurnFile(sessionId), { rules: turn.rules || [], repo: turn.repo || '', ts: turn.ts || Date.now() });

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

module.exports = { CHECK_IDS, home, loadRules, saveRules, appendInbox, readInbox, normalize, score, decay, importRules, sweep, bump, bumpSessions, violate, writeTurn, readTurn, clearTurn, saveLastTurn, loadLastTurn, recordOutcome };
