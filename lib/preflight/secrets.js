'use strict';

const crypto = require('node:crypto');

const RULES = [
  { rule: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  { rule: 'github-token', re: /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { rule: 'slack-token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { rule: 'stripe-key', re: /[sr]k_live_[A-Za-z0-9]{10,}/g },
  { rule: 'ai-api-key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { rule: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: 'generic-assignment', re: /(?:api_?key|secret|token|password)['"]?\s*[:=]\s*['"]([^'"]{12,})['"]/gi, group: 1 },
  { rule: 'high-entropy', re: /['"]([A-Za-z0-9+/=_-]{32,})['"]/g, group: 1, minEntropy: 4.0 },
];

function entropy(s) {
  const freq = {};
  for (const ch of s) freq[ch] = (freq[ch] || 0) + 1;
  return -Object.values(freq).reduce((sum, n) => sum + (n / s.length) * Math.log2(n / s.length), 0);
}

function fingerprint(value, salt = '') {
  return crypto.createHash('sha256').update(salt + value).digest('hex').slice(0, 8);
}

// Returns findings for one line. Values are only hashed, never returned.
function scanLine(text, where, salt) {
  const seen = new Set();
  const found = [];
  for (const { rule, re, group = 0, minEntropy } of RULES) {
    for (const m of text.matchAll(re)) {
      const value = m[group];
      if (seen.has(value) || (minEntropy && entropy(value) < minEntropy)) continue;
      seen.add(value);
      found.push({ rule, ...where, fingerprint: fingerprint(value, salt) });
    }
  }
  return found;
}

module.exports = { RULES, entropy, fingerprint, scanLine };
