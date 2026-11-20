'use strict';
const store = require('./store');
const { redact } = require('../prefs/redact');

const CORRECTION = /^\s*(no|nope|wait|undo|revert|i (dont|don't|didnt|didn't) mean|that's not|thats not|not what i|why did you|stop)\b|\bi said\b/i;

const isCorrection = (prompt) => CORRECTION.test(String(prompt || ''));

// Called from the prompt hook. Judges the previous turn's rules by how the user reacts now.
// Never throws. Returns {correction, rules} or null when there was no previous turn.
function onPrompt({ prompt, sessionId, repo } = {}) {
  try {
    if (!sessionId) return null;
    const prev = store.loadLastTurn(sessionId);
    if (!prev || !Array.isArray(prev.rules) || !prev.rules.length) return null;
    const where = repo || prev.repo || '';
    const correction = isCorrection(prompt);
    store.recordOutcome(prev.rules, where, correction);
    if (correction) {
      const text = redact(String(prompt)).slice(0, 240);
      store.appendInbox([{ session_id: String(sessionId), text, prompt: text, prevRules: prev.rules, repo: where, ts: Date.now() }]);
    }
    return { correction, rules: prev.rules };
  } catch {
    return null;
  }
}

module.exports = { onPrompt, isCorrection };
