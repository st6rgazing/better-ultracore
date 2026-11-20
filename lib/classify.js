'use strict';

const REVIEW_VERB = /\b(review|audit|check|explain|inspect|assess)\b/i;
const CHANGE_VERB = /\b(add|fix|change|update|implement|create|refactor|rename|remove|write|build|make|replace|move|improve|migrate|set|bump)\b/i;
const RISK = /\b(auth\w*|password\w*|token\w*|payment\w*|migration\w*|deploy\w*|delete\w*|permission\w*|security|secrets?)\b/i;

function classify(request) {
  const text = String(request || '').trim();
  if (REVIEW_VERB.test(text) && !CHANGE_VERB.test(text)) {
    return { route: 'review', reason: 'review-only verb, no change verb', confidence: 'high' };
  }
  const risk = text.match(RISK);
  if (risk) {
    return { route: 'guarded', reason: `risk keyword "${risk[0].toLowerCase()}"`, confidence: 'high' };
  }
  return { route: 'planned', reason: 'no signal fired', confidence: 'uncertain' };
}

module.exports = { classify };
