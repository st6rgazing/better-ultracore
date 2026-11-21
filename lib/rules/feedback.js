'use strict';
const store = require('./store');
const handsoff = require('../handsoff');
const { redact } = require('../prefs/redact');

const CORRECTION = /^\s*(no|nope|wait|undo|revert|i (dont|don't|didnt|didn't) mean|that's not|thats not|not what i|why did you|stop)\b|\bi said\b/i;

const isCorrection = (prompt) => CORRECTION.test(String(prompt || ''));

// Called from the prompt hook. Counts the prompt for the repo's hands-off evidence (handsoff.record),
// then judges the previous turn's rules by how the user reacts now.
// Never throws. Returns {correction, rules} or null when there was no previous turn.
function onPrompt({ prompt, sessionId, repo } = {}) {
  handsoff.record({ prompt, repo, sessionId });
  try {
    if (!sessionId) return null;
    const prev = store.loadLastTurn(sessionId);
    if (!prev || !Array.isArray(prev.rules) || !prev.rules.length) return null;
    const where = repo || prev.repo || '';
    const correction = isCorrection(prompt);
    store.recordOutcome(prev.rules, where, correction);
    // ExpeL-style vote on each shown rule; one at zero is archived (lib/rules/votes.js).
    require('./votes').record(prev.rules, correction);
    if (correction) {
      const text = redact(String(prompt)).slice(0, 240);
      store.appendInbox([{ session_id: String(sessionId), text, prompt: text, prevRules: prev.rules, repo: where, h: store.hash(text), ts: new Date(store.now()).toISOString() }]);
    }
    return { correction, rules: prev.rules };
  } catch {
    return null;
  }
}

module.exports = { onPrompt, isCorrection };
