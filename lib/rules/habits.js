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

// "in all my projects", "everywhere": the habit is meant for every repo.
const GLOBAL = /\b(in|for|on|across) (all|every|each)( of)?( my| the| our)? (projects?|repos?|repositories|codebases?)\b|\beverywhere\b|\bglobally\b/i;

// Returns the ids of habits stated in this prompt, after storing them. Never throws.
// repo is context.repoKey of where it was said: the habit applies there only (scope.repos). It becomes global, with no
// scope, when stated in a second repo or with a global cue. A null or empty repo (not in a git repo) stores nothing
// unless the cue is there. Calling with one argument keeps the pre-v10 behaviour: global.
function capture(prompt, repo) {
  try {
    const text = String(prompt || '').trim();
    if (!text || text.split(/\s+/).length > MAX_WORDS) return [];
    const hits = HABITS.filter((h) => h.test(text)).map((h) => h.rule);
    if (!hits.length) return [];
    const global = repo === undefined || GLOBAL.test(text);
    if (!global && !repo) return [];
    const have = new Set(store.loadRules().map((r) => r.id));
    const fresh = hits.filter((r) => !have.has(r.id));
    if (fresh.length) store.importRules(fresh.map((r) => ({ ...r, origin: 'habit', ...(!global && { scope: { repos: [repo] } }) })));
    const again = hits.filter((r) => have.has(r.id)).map((r) => r.id);
    store.bump(again);
    store.updateRules(again, (r) => {
      if (!r.scope) return;
      const repos = [...new Set([...(r.scope.repos || []), ...(repo ? [repo] : [])])];
      if (global || repos.length >= 2) delete r.scope;
      else r.scope = { repos };
    });
    return hits.map((r) => r.id);
  } catch {
    return [];
  }
}

module.exports = { capture, HABITS };
