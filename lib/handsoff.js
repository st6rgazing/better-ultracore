'use strict';
// Hands-off mode: in some repos the user wants the steps, not edits. Per repo, explicit setting first, evidence second.
//
// v10 shared contract (workstreams A and B code against these; the same list is in docs/rules.md):
//
//   store.now() -> number
//     Epoch ms. BUC_NOW (ISO date or epoch ms) pins it.
//   store.off(name, root = process.cwd()) -> boolean
//     True when `name` is in BUC_OFF (comma list) or in "off" of <root>/.claude/buc.json (array or comma list).
//   store.repoState(repo) -> {handsOff?: 'on'|'off'|'auto', events: [{e, s, ts}]}
//     repo is context.repoKey(root). Never throws; unknown repo gives {events: []}.
//   store.recordRepo(repo, event, sessionId, ts = store.now()) -> state | null
//     Appends {e: event, s: sessionId, ts: ISO}. Keeps the newest 400. Names only, no prompt text.
//   store.setRepo(repo, patch) -> state | null
//   store.patchTurn(sessionId, patch) -> turn          merge fields into the turn file
//   store.saveLastTurn(sessionId, {rules?, repo?, ts?, head?, files?})
//     With `rules` it starts a new record; without, it merges {head, files} into the stored one.
//   Turn-file fields {intent, ui, toolCalls, shotAt, prevFiles}: see the comment above turnFile in lib/rules/store.js.
//   store.asOf(rules, {before, excludeSessions}) -> rules
//
//   handsoff.isStatement(prompt) -> boolean            an explicit hands-off statement
//   handsoff.isApply(prompt) -> boolean                'apply', 'do it', 'go ahead' at the start; never gate these
//   handsoff.record({prompt, repo, sessionId, kind?, ts?}) -> 'handsoff' | 'apply' | 'edit' | null
//     Called once per prompt by feedback.onPrompt; callers of onPrompt need not call it again. Never throws.
//   handsoff.mode(repo, {now?, root?}) -> {mode, events, sessions, edits, ratio}
//     mode is 'on' | 'off' | 'auto-active' | 'auto-idle'. Gate edits when mode is 'on' or 'auto-active' (handsoff.active(repo)).
//     events: net statements in the window (statements minus applies); sessions: sessions with a net statement;
//     edits: edit prompts in the window; ratio: events / (edits + statements).
//   handsoff.active(repo, opts) -> boolean
//   handsoff.set(repo, 'on' | 'off' | 'auto') -> state | null
//
// auto is the default when nothing is set. It turns active at 3 net statements from 2 sessions within 60 days
// that are at least 30% of the repo's edit prompts. BUC_OFF=handsoff forces 'off'.

const store = require('./rules/store');

const DAY = 86400000;
const WINDOW_DAYS = 60;
const MIN_EVENTS = 3;
const MIN_SESSIONS = 2;
const MIN_RATIO = 0.3;
const SETTINGS = ['on', 'off', 'auto'];
const STATEMENT = /\b(don'?t|do not) (change|modify|edit|touch) anything\b|\bundo (all )?(your|the|those) changes\b|\bjust (show|tell) me\b|\bshow me how\b/i;
const APPLY = /^\s*((ok(ay)?|yes|yep|sure|please)[,.! ]+)*(apply|do it|go ahead)\b/i;

const isStatement = (prompt) => STATEMENT.test(String(prompt || ''));
const isApply = (prompt) => APPLY.test(String(prompt || ''));

// Counts over the last 60 days up to `now`. An apply cancels one statement of its own session.
function counts(events, now) {
  const recent = events.filter((e) => { const t = Date.parse(e.ts); return t <= now && now - t <= WINDOW_DAYS * DAY; });
  const net = {};
  let statements = 0;
  let edits = 0;
  for (const e of recent) {
    if (e.e === 'handsoff') { net[e.s] = (net[e.s] || 0) + 1; statements += 1; }
    else if (e.e === 'apply') net[e.s] = (net[e.s] || 0) - 1;
    else if (e.e === 'edit') edits += 1;
  }
  const left = Object.values(net).filter((n) => n > 0);
  const total = left.reduce((a, n) => a + n, 0);
  return { events: total, sessions: left.length, edits, ratio: statements + edits ? total / (statements + edits) : 0 };
}

// {mode: 'on' | 'off' | 'auto-active' | 'auto-idle', events, sessions, edits, ratio}. Never throws.
function mode(repo, { now = store.now(), root } = {}) {
  try {
    const st = store.repoState(repo);
    const c = counts(st.events, now);
    if (store.off('handsoff', root)) return { mode: 'off', ...c };
    if (st.handsOff === 'on' || st.handsOff === 'off') return { mode: st.handsOff, ...c };
    const active = c.events >= MIN_EVENTS && c.sessions >= MIN_SESSIONS && c.ratio >= MIN_RATIO;
    return { mode: active ? 'auto-active' : 'auto-idle', ...c };
  } catch {
    return { mode: 'auto-idle', events: 0, sessions: 0, edits: 0, ratio: 0 };
  }
}

module.exports = { isStatement, isApply, mode, SETTINGS };
