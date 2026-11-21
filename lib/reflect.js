'use strict';
// Reflections in the style of Reflexion: after a correction, keep one line of the form "assumed X, user wanted Y" and
// reuse it later. Here the line is one of four fixed sentences chosen by the kind of correction, so no model call is
// needed and no user text is kept: a candidate is {k, h, s, repo, ts} in $BUC_HOME/reflections.jsonl, with h the hash of the
// correction. A candidate becomes a rule only after it recurs twice. BUC_OFF name: reflect.
const fs = require('node:fs');
const path = require('node:path');
const store = require('./rules/store');

// One per correction pattern of lib/intent.js readCorrection. A pattern not listed here is not captured.
const TEMPLATES = {
  overshoot: { rule: 'You assumed a big change; the user wanted a small step. On a degree word, change by the smallest visible step.', keywords: ['slightly', 'bit', 'little', 'smaller', 'bigger', 'larger', 'more', 'less', 'tweak', 'subtle'], promptKinds: ['edit'] },
  still: { rule: 'You assumed a fix worked; the user still saw it broken. Run or trace the exact path they named before saying it works.', keywords: ['fix', 'bug', 'broken', 'error', 'crash', 'failing', 'working'], promptKinds: ['edit'] },
  misread: { rule: 'You assumed a reading the user rejected. Name your reading in the first line; when two fit, take the narrower.', keywords: ['make', 'add', 'change', 'update', 'move', 'remove'], promptKinds: ['edit'] },
  'undo-show': { rule: 'You assumed edits were wanted; the user wanted steps. When a request could be a question, answer in text first.', keywords: ['how', 'show', 'explain', 'tell', 'why', 'what'], promptKinds: [] },
};

const file = () => path.join(store.home(), 'reflections.jsonl');

// Stored candidates, oldest first; [] when there are none. A line that does not parse is skipped.
function read() {
  try {
    return fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch {
    return [];
  }
}

const NEEDED = 3; // the first sighting and two recurrences
const MIN_SESSIONS = 2;

// The patterns ready to become a rule in a repo: at least 3 candidates there from at least 2 sessions. Pure.
function due(list, repo) {
  const out = [];
  for (const k of Object.keys(TEMPLATES)) {
    const mine = list.filter((c) => c && c.k === k && c.repo === repo);
    if (mine.length >= NEEDED && new Set(mine.map((c) => c.s)).size >= MIN_SESSIONS) out.push(k);
  }
  return out;
}

const write = (list) => {
  fs.mkdirSync(store.home(), { recursive: true });
  fs.writeFileSync(file(), list.map((c) => `${JSON.stringify(c)}\n`).join(''));
};

// Turns each due pattern of a repo into the rule reflect-<pattern>, scoped to that repo (a rule that exists gains the
// repo), with the candidates as its sources. The candidates used are removed, so a rule that votes later evict needs
// three fresh corrections to come back. Returns the rule ids stored.
function promote(repo) {
  const list = read();
  const ready = due(list, repo);
  if (!ready.length) return [];
  const used = (c) => c && c.repo === repo && ready.includes(c.k);
  const rules = ready.map((k) => {
    const mine = list.filter((c) => c.repo === repo && c.k === k);
    const t = TEMPLATES[k];
    return {
      id: `reflect-${k}`, rule: t.rule, when: { keywords: t.keywords, promptKinds: t.promptKinds }, kind: 'process', origin: 'learn', count: mine.length,
      sources: mine.map((c) => ({ session: c.s, repo, ts: c.ts, h: c.h })), scope: { repos: [repo] },
    };
  });
  const { added } = store.importRules(rules);
  store.updateRules(added, (r) => { if (r.scope && Array.isArray(r.scope.repos) && !r.scope.repos.includes(repo)) r.scope.repos.push(repo); });
  if (added.length) write(list.filter((c) => !used(c)));
  return added;
}

module.exports = { TEMPLATES, read, file, due, promote, NEEDED, MIN_SESSIONS };
