'use strict';
const store = require('./store');

// Standing habits the user states outright. Each becomes a pinned rule with a deterministic check the moment it is said,
// so it holds from that turn on and in later sessions without waiting for a mining pass.
const STANDING = /\b(always|constantly|every ?time|from now on|every (little|small|single) (change|feature|thing|fix|step))\b/i;
const HABITS = [
  {
    test: (text) => /\bcommit/i.test(text) && STANDING.test(text) && !/\b(don'?t|do not|never|stop|no) (\w+ )?commit/i.test(text),
    rule: {
      id: 'commit-as-you-go',
      rule: 'Commit after each small completed change: one logical change per commit, plain one-line message.',
      when: { keywords: ['commit'], paths: [], promptKinds: ['edit', 'commit'] },
      check: { cmd: 'commit-changes' },
      kind: 'git',
      pinned: true,
    },
  },
];
const MAX_WORDS = 40;

// Returns the ids of habits stated in this prompt, after storing them. Never throws.
function capture(prompt) {
  try {
    const text = String(prompt || '').trim();
    if (!text || text.split(/\s+/).length > MAX_WORDS) return [];
    const hits = HABITS.filter((h) => h.test(text)).map((h) => h.rule);
    if (!hits.length) return [];
    const have = new Set(store.loadRules().map((r) => r.id));
    const fresh = hits.filter((r) => !have.has(r.id));
    if (fresh.length) store.importRules(fresh);
    store.bump(hits.filter((r) => have.has(r.id)).map((r) => r.id));
    return hits.map((r) => r.id);
  } catch {
    return [];
  }
}

module.exports = { capture, HABITS };
