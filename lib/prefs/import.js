'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { redact } = require('./redact');

// Yields {sessionId, text, line} for each user text turn; tool_result and malformed lines are skipped.
function* userTurns(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!entry || entry.type !== 'user' || !entry.message) continue;
    const { content } = entry.message;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
        : '';
    if (text.trim()) yield { sessionId: entry.sessionId || 'unknown', text, line: i + 1 };
  }
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/^\s*(no|please)[,.\s]+/, '')
    .replace(/[^a-z0-9*/. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function idFor(canon) {
  return crypto.createHash('sha1').update(normalize(canon)).digest('hex').slice(0, 8);
}

const BUILTINS = [
  {
    re: /\b(look at|check) main\b/i,
    canon: 'look at main',
    kind: 'check',
    keywords: ['main', 'branch', 'remote', 'commit', 'review'],
    check: 'verify exact remote commit: git ls-remote origin main equals the SHA you inspected',
  },
  {
    re: /\bkeep (the )?code snippets? minimal\b/i,
    canon: 'keep code snippets minimal',
    kind: 'output',
    keywords: ['snippet', 'snippets', 'example', 'code'],
    check: null,
  },
  {
    re: /\bcheck after (a )?refresh\b/i,
    canon: 'check after refresh',
    kind: 'check',
    keywords: ['persist', 'save', 'state', 'localStorage', 'refresh', 'form', 'db'],
    check: 'suggest browser test: reload page and verify state persisted',
  },
];

const EXPLICIT = /^\s*(always|never)\b/i;
const CORRECTION = /^\s*(?:(?:always|never|don'?t|do not|stop|i said|please keep)\b|no,)/i;

// Returns {text, explicit, builtin} for the first sentence that looks like a correction, else null.
function detect(turnText) {
  for (const raw of turnText.split(/(?<=[.!?])\s+|\n+/)) {
    const text = raw.trim();
    if (!text) continue;
    const builtin = BUILTINS.find((b) => b.re.test(text)) || null;
    if (builtin || CORRECTION.test(text)) return { text, explicit: EXPLICIT.test(text), builtin };
  }
  return null;
}

const STOP = new Set('always never dont do not stop said please keep that this with from have into than then when what your you the and for are was but its use using'.split(' '));

function keywordsOf(text) {
  const words = normalize(text).split(' ').filter((w) => w.length >= 4 && !STOP.has(w));
  return [...new Set(words)].slice(0, 6);
}

function pathsOf(text) {
  return [...new Set(text.match(/(?:[\w.-]+\/)+[\w.*-]*|\*\.\w+/g) || [])];
}

function toRecord({ text, explicit, builtin }, turn, file, scope) {
  const canon = builtin ? builtin.canon : text;
  return {
    id: idFor(canon),
    correction: redact(text).slice(0, 200),
    source: { session_id: turn.sessionId, file, line: turn.line },
    scope,
    trigger: { keywords: builtin ? builtin.keywords : keywordsOf(text), paths: pathsOf(text) },
    check: builtin ? builtin.check : null,
    kind: builtin ? builtin.kind : 'instruction',
    status: explicit ? 'confirmed' : 'suggested',
    sessions: [turn.sessionId],
    created: new Date().toISOString(),
  };
}

module.exports = { userTurns, normalize, idFor, detect, toRecord };
