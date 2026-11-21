'use strict';
// Rule votes in the style of ExpeL (insights are upvoted or downvoted and dropped at zero), with the caps IFScale argues for
// (compliance falls as the number of instructions grows). The per-repo hits and misses in store.js only reweight a rule;
// votes decide whether it stays. BUC_OFF name: votes.
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

const START = 2; // a new rule survives one correction, not two in a row
const MAX_VOTES = 10;
const MAX_ACTIVE = 30;
const MAX_INJECTED = 3;

const votesOf = (rule) => (Number.isFinite(rule.votes) ? rule.votes : START);

// A rule's votes after one more showing: +1 when no correction followed, -1 when one did; kept within 0..10.
function next(rule, correction) {
  return Math.max(0, Math.min(MAX_VOTES, votesOf(rule) + (correction ? -1 : 1)));
}

// Splits a rule list into {keep, out}: a rule at zero votes goes, then the lowest-scored rules beyond the 30th.
// A pinned rule is never moved. Pure.
function split(rules, now = store.now()) {
  const gone = new Set(rules.filter((r) => !r.pinned && votesOf(r) <= 0).map((r) => r.id));
  const ranked = rules.filter((r) => !gone.has(r.id)).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || store.score(b, now) - store.score(a, now) || (a.id < b.id ? -1 : 1));
  for (const r of ranked.slice(MAX_ACTIVE)) if (!r.pinned) gone.add(r.id);
  return { keep: rules.filter((r) => !gone.has(r.id)), out: rules.filter((r) => gone.has(r.id)) };
}

// Moves what split() drops from rules.json to rules.archive.json; returns the ids moved. Nothing is written when nothing goes.
function evict(now = store.now()) {
  const { keep, out } = split(store.loadRules(), now);
  if (!out.length) return [];
  const file = path.join(store.home(), 'rules.archive.json');
  let archive = [];
  try { archive = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no archive yet */ }
  fs.writeFileSync(file, `${JSON.stringify([...(Array.isArray(archive) ? archive : []), ...out], null, 2)}\n`);
  store.saveRules(keep);
  return out.map((r) => r.id);
}

module.exports = { votesOf, next, split, evict, START, MAX_VOTES, MAX_ACTIVE, MAX_INJECTED };
