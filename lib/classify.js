'use strict';

const REVIEW_VERB = /\b(review|audit|check|explain|inspect|assess)\b/i;
const CHANGE_VERB = /\b(add|fix|change|update|implement|create|refactor|rename|remove|write|build|make|replace|move|improve|migrate|set|bump)\b/i;
const REVIEW_LEAD = /^\s*(?:(?:please|can you|could you)\s+)?(?:review|audit|inspect|explain|assess|check (?:whether|if)|tell me (?:what|why|how))\b/i;
const IMPERATIVE_CHANGE = /\b(fix|change|add|remove|rename|implement|update|refactor|replace|migrate|create|delete|rewrite|bump)\b/i;
const RISK =/\b(auth\w*|password\w*|token\w*|payment\w*|migration\w*|deploy\w*|delete\w*|permission\w*|security|secrets?)\b/i;

const FILE = /[\w./-]+\.(?:js|ts|tsx|jsx|py|md|json|css|html|go|rs|java|sh)\b/g;
const CRITERIA = /\b(should|must|acceptance|npm test|node --test|pytest|go test)\b|^\s*[-*]\s/im;
const VAGUE = /\b(improve|something like|add a feature|better|somehow|clean ?up|enhance|overhaul)\b/i;
const PROHIBITION = /\b(do not|don't|never|without)\b[^.]*/gi;
const PARALLEL = /\band also\b|\bin parallel\b|\bindependent(ly)?\b/i;

function numberedParts(text) {
  return (text.match(/^\s*\d+[.)]\s/gm) || []).length;
}

function classify(request, { files = [] } = {}) {
  const text = String(request || '').trim();
  const hasCriteria = CRITERIA.test(text);
  const namedFiles = new Set([...(text.match(FILE) || []), ...files].map((f) => f.split('/').pop())).size;
  const out = (route, reason, confidence = 'high') => ({ route, reason, confidence, hasCriteria, namedFiles });
  if (REVIEW_VERB.test(text) && !CHANGE_VERB.test(text)) {
    return out('review', 'review-only verb, no change verb');
  }
  if (REVIEW_LEAD.test(text) && !IMPERATIVE_CHANGE.test(text)) {
    return out('review', 'request leads with a review verb, no change pattern');
  }
  const risk = text.replace(PROHIBITION, '').match(RISK);
  if (risk) {
    return out('guarded', `risk keyword "${risk[0].toLowerCase()}"`);
  }
  if (PARALLEL.test(text) || (numberedParts(text) >= 2 && namedFiles >= 2)) {
    return out('parallel', 'explicit independent parts');
  }
  const vague = VAGUE.test(text);
  const short = text.split(/\s+/).length <= 60;
  const concrete = hasCriteria || (namedFiles === 1 && CHANGE_VERB.test(text));
  if (concrete && vague) return out('planned', 'concrete and vague signals conflict', 'uncertain');
  if (vague) return out('planned', 'vague or multi-step request');
  if (!hasCriteria && text.split(/[.!?]\s/).length >= 3) return out('planned', 'several sentences without criteria');
  if (!hasCriteria && namedFiles >= 2) return out('planned', 'several files without criteria');
  if (concrete && short) return out('small', hasCriteria ? 'explicit criteria, short' : 'single file, concrete change');
  if (short && namedFiles <= 1 && CHANGE_VERB.test(text)) return out('inline-plan', 'short change, no criteria: assume acceptance inline');
  return out('planned', 'no signal fired', 'uncertain');
}

module.exports = { classify };
