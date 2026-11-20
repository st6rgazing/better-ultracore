'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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

// Parses `-U0` patch text (optionally with "commit:<sha>" markers) into added lines.
function* addedLines(patch) {
  let commit;
  let file;
  let line = 0;
  for (const text of patch.split('\n')) {
    if (text.startsWith('commit:')) commit = text.slice(7);
    else if (text.startsWith('+++ ')) file = text.slice(4).replace(/^b\//, '');
    else if (text.startsWith('@@')) line = Number(/\+(\d+)/.exec(text)[1]);
    else if (text.startsWith('+') && file) yield { commit, file, line: line++, text: text.slice(1) };
  }
}

function scanPatch(patch, salt, withCommit) {
  const out = [];
  for (const { commit, file, line, text } of addedLines(patch)) {
    out.push(...scanLine(text, withCommit ? { file, line, commit } : { file, line }, salt));
  }
  return out;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function scanDiff(cwd, base, head, salt) {
  return scanPatch(git(cwd, ['diff', '-U0', '--no-color', base, head]), salt, false);
}

function scanCommits(cwd, base, head, salt) {
  const range = base ? `${base}..${head}` : head;
  const patch = git(cwd, ['log', '-p', '-U0', '--no-color', '--format=commit:%H', range]);
  return scanPatch(patch, salt, true);
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function scanText(text, file, salt) {
  return text.split('\n').flatMap((t, i) => scanLine(t, { file, line: i + 1 }, salt));
}

// Scans every dist file; for .map files scans the embedded sourcesContent.
function scanDist(distDir, salt) {
  const out = [];
  for (const p of walk(distDir)) {
    const rel = path.relative(distDir, p);
    const raw = fs.readFileSync(p, 'utf8');
    if (!p.endsWith('.map')) {
      out.push(...scanText(raw, rel, salt));
      continue;
    }
    let map;
    try { map = JSON.parse(raw); } catch { out.push(...scanText(raw, rel, salt)); continue; }
    (map.sourcesContent || []).forEach((src, i) => {
      out.push(...scanText(src || '', `${rel}!${(map.sources || [])[i] || i}`, salt));
    });
  }
  return out;
}

function isAllowed(f, allow = {}) {
  return (allow.fingerprints || []).includes(f.fingerprint) || (allow.paths || []).some(p => f.file.includes(p));
}

// Findings carry rule/file/line/commit/fingerprint only, never the value.
function run({ dir, distDir, base, head = 'HEAD', config = {} }) {
  const salt = config.salt || '';
  let findings = [];
  try {
    if (base) findings.push(...scanDiff(dir, base, head, salt));
    findings.push(...scanCommits(dir, base, head, salt));
    if (fs.existsSync(distDir)) findings.push(...scanDist(distDir, salt));
  } catch (e) {
    return { status: 'unverified', detail: `scan error: ${e.code || e.status || 'unknown'}`, findings: [] };
  }
  findings = findings.filter(f => !isAllowed(f, config.allow));
  const uniq = [...new Map(findings.map(f => [JSON.stringify(f), f])).values()];
  return {
    status: uniq.length ? 'failed' : 'passed',
    detail: uniq.length ? `${uniq.length} potential secret(s)` : 'no secrets found',
    findings: uniq,
  };
}

module.exports = { RULES, entropy, fingerprint, scanLine, scanDiff, scanCommits, scanDist, run };
