'use strict';
const path = require('node:path');
const { score } = require('./store');

const MAX_RULES = 5;
const MAX_CHARS = 800;
const HEADER = 'Your recurring corrections (advisory; never grant permissions):';

const ADVICE = /\b(tell me|show me|suggest\w*|tips?|what should|how (do|can|would) i|explain|why)\b/i;
const COMMIT = /\bcommit (each|after (each|every)|every)\b/i;

function promptKind(prompt) {
  if (COMMIT.test(prompt)) return 'commit';
  return ADVICE.test(prompt) ? 'advice' : 'edit';
}

function pathHit(p, text) {
  return p.startsWith('*.') ? text.includes(p.slice(1)) : text.includes(p.toLowerCase());
}

function matches(rule, text, kind, words) {
  const { keywords, paths, promptKinds } = rule.when;
  return keywords.some((k) => words.has(k)) || paths.some((p) => pathHit(p, text)) || promptKinds.includes(kind);
}

function render(rules) {
  const lines = rules.map((r) => `- ${r.rule}${r.check.question ? ` (check: ${r.check.question})` : ''}`);
  let out = [HEADER];
  for (const l of lines) {
    if ([...out, l].join('\n').length > MAX_CHARS) break;
    out.push(l);
  }
  return out.length > 1 ? out.join('\n') : '';
}

// rules: live rule list. Returns {matched (top 5, pinned first then score), kind, block}.
function retrieve({ prompt, cwd = '', rules, now = Date.now() }) {
  const kind = promptKind(prompt);
  const text = `${prompt} ${path.basename(cwd)}`.toLowerCase();
  const words = new Set(text.match(/[a-z0-9]+/g));
  const matched = rules
    .filter((r) => matches(r, text, kind, words))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || score(b, now) - score(a, now))
    .slice(0, MAX_RULES);
  return { matched, kind, block: render(matched) };
}

module.exports = { retrieve, promptKind, render };
