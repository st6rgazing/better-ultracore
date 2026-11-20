'use strict';

const crypto = require('crypto');
const fs = require('fs');

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

module.exports = { userTurns, normalize, idFor };
