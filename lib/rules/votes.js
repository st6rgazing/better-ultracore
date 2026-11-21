'use strict';
// Rule votes in the style of ExpeL (insights are upvoted or downvoted and dropped at zero), with the caps IFScale argues for
// (compliance falls as the number of instructions grows). The per-repo hits and misses in store.js only reweight a rule;
// votes decide whether it stays. BUC_OFF name: votes.
const START = 2; // a new rule survives one correction, not two in a row
const MAX_VOTES = 10;
const MAX_ACTIVE = 30;
const MAX_INJECTED = 3;

const votesOf = (rule) => (Number.isFinite(rule.votes) ? rule.votes : START);

// A rule's votes after one more showing: +1 when no correction followed, -1 when one did; kept within 0..10.
function next(rule, correction) {
  return Math.max(0, Math.min(MAX_VOTES, votesOf(rule) + (correction ? -1 : 1)));
}

module.exports = { votesOf, next, START, MAX_VOTES, MAX_ACTIVE, MAX_INJECTED };
