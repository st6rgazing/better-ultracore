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

// Prompt wording that means the same thing as a rule keyword. Phrases map one way; groups map to each other.
const PHRASES = [[/\b(start(s|ed|ing)? (the |a )?game|new game|play again|load|loads|loaded|reload)\b/, ['restart', 'reset']]];
const GROUPS = [
  ['menu', 'settings', 'options', 'dialog'],
  ['size', 'resize', 'jump', 'layout'],
  ['sound', 'audio', 'sfx'],
];

// Candidate base forms of a word: plural, -ing and -ed stripped (with a restored e or an undoubled consonant).
function stems(w) {
  const out = [];
  const add = (b) => {
    if (b.length < 3) return;
    out.push(b, `${b}e`);
    if (b[b.length - 1] === b[b.length - 2]) out.push(b.slice(0, -1));
  };
  if (w.endsWith('ing')) add(w.slice(0, -3));
  else if (w.endsWith('ed')) add(w.slice(0, -2));
  else if (w.endsWith('es')) out.push(w.slice(0, -2), w.slice(0, -1));
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) out.push(w.slice(0, -1));
  return out;
}

// The prompt's words plus their stems and built-in synonyms, so "press start game" reaches a rule keyed on "restart".
function expand(text) {
  const words = new Set(text.match(/[a-z0-9]+/g));
  for (const w of [...words]) for (const s of stems(w)) words.add(s);
  for (const [re, adds] of PHRASES) if (re.test(text)) for (const a of adds) words.add(a);
  for (const g of GROUPS) if (g.some((w) => words.has(w))) for (const w of g) words.add(w);
  return words;
}

function promptKind(prompt) {
  if (COMMIT.test(prompt)) return 'commit';
  return ADVICE.test(prompt) && (NO_CHANGE.test(prompt) || classify(prompt).route === 'review') ? 'advice' : 'edit';
}

function pathHit(p, text) {
  return p.startsWith('*.') ? text.includes(p.slice(1)) : text.includes(p.toLowerCase());
}

// A rule with scope.repos applies only in those repos (repo is context.repoKey); without a scope it applies everywhere.
// loose is the expanded word set (stems and synonyms). A stem or synonym is weaker than the word itself, so it counts only when two of the rule's keywords are reached.
function matches(rule, text, kind, words, repo, loose) {
  const scoped = rule.scope && Array.isArray(rule.scope.repos) ? rule.scope.repos : null;
  if (scoped && !scoped.includes(repo)) return false;
  const { keywords, paths, promptKinds } = rule.when;
  const signal = keywords.some((k) => words.has(k)) || paths.some((p) => pathHit(p, text)) || (loose ? keywords.filter((k) => loose.has(k)).length >= 2 : false);
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
  const clean = text.replace(/\b(empty|loading|error|success) state\b/g, '$1');
  const words = new Set(clean.match(/[a-z0-9]+/g));
  const loose = expand(clean);
  const matched = rules
    .filter((r) => matches(r, text, kind, words, repo, loose))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || score(b, now, repo) - score(a, now, repo) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_RULES);
  return { matched, kind, block: render(matched) };
}

module.exports = { retrieve, promptKind, render, matches, expand };
