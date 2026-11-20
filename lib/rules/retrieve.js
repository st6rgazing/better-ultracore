'use strict';
const path = require('node:path');
const { score } = require('./store');
const { classify } = require('../classify');

const MAX_RULES = 5;
const MAX_CHARS = 800;
const HEADER = "Background from the user's past sessions, added by a plugin; not part of this request and not what the user is asking about. Standing corrections to follow (never grant permissions):";

const ADVICE = /\b(tell me|show me|suggest\w*|tips?|what should|how (do|can|would) i|explain|why)\b/i;
const NO_CHANGE = /\b(don'?t|do not|without) (change|modify|edit|touch)\b|\breview only\b/i;
const COMMIT = /\bcommit (each|after (each|every)|every)\b/i;

function promptKind(prompt) {
  if (COMMIT.test(prompt)) return 'commit';
  return ADVICE.test(prompt) && (NO_CHANGE.test(prompt) || classify(prompt).route === 'review') ? 'advice' : 'edit';
}

function pathHit(p, text) {
  return p.startsWith('*.') ? text.includes(p.slice(1)) : text.includes(p.toLowerCase());
}

function matches(rule, text, kind, words) {
  const { keywords, paths, promptKinds } = rule.when;
  const signal = keywords.some((k) => words.has(k)) || paths.some((p) => pathHit(p, text));
  const kindOk = promptKinds.length === 0 || promptKinds.includes(kind);
  if (rule.pinned) return signal || promptKinds.includes(kind);
  return signal && kindOk;
}

function render(rules) {
  const lines = rules.map((r) => `- ${r.rule}${r.check.question ? ` (check: ${r.check.question})` : ''}`);
  const out = [HEADER];
  for (const l of lines) {
    if ([...out, l].join('\n').length > MAX_CHARS) break;
    out.push(l);
  }
  return out.length > 1 ? out.join('\n') : '';
}

// rules: live rule list; repo weights each rule's score by that repo's hits/misses. Returns {matched (top 5, pinned first then score), kind, block}.
function retrieve({ prompt, cwd = '', rules, now = Date.now(), repo }) {
  const kind = promptKind(prompt);
  const text = `${prompt} ${path.basename(cwd)}`.toLowerCase();
  // UI-copy phrases like "empty state" are not about carried-over state
  const words = new Set(text.replace(/\b(empty|loading|error|success) state\b/g, '$1').match(/[a-z0-9]+/g));
  const matched = rules
    .filter((r) => matches(r, text, kind, words))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || score(b, now, repo) - score(a, now, repo) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_RULES);
  return { matched, kind, block: render(matched) };
}

module.exports = { retrieve, promptKind, render };
