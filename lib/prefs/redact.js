'use strict';

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi,
];

function redact(text) {
  let out = String(text);
  for (const re of PATTERNS) out = out.replace(re, '[REDACTED]');
  return out.replace(/[A-Za-z0-9+/_=-]{24,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '[REDACTED]' : m));
}

module.exports = { redact };
