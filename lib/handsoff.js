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

const STATEMENT = /\b(don'?t|do not) (change|modify|edit|touch) anything\b|\bundo (all )?(your|the|those) changes\b|\bjust (show|tell) me\b|\bshow me how\b/i;
const APPLY = /^\s*((ok(ay)?|yes|yep|sure|please)[,.! ]+)*(apply|do it|go ahead)\b/i;

const isStatement = (prompt) => STATEMENT.test(String(prompt || ''));
const isApply = (prompt) => APPLY.test(String(prompt || ''));

module.exports = { isStatement, isApply };
