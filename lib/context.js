'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { classify } = require('./classify');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function tryGit(cwd, ...args) {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

function repoInfo(cwd) {
  const root = git(cwd, 'rev-parse', '--show-toplevel');
  return {
    root,
    head: git(root, 'rev-parse', 'HEAD'),
    branch: tryGit(root, 'rev-parse', '--abbrev-ref', 'HEAD'),
    upstream: tryGit(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'),
  };
}

// Compares a local ref with origin without fetching. stale = remote tip not contained in local ref.
function refStatus(cwd, ref, { offline = false } = {}) {
  const local = tryGit(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`)
    || tryGit(cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}`);
  let remote = null;
  if (!offline) {
    const line = tryGit(cwd, 'ls-remote', 'origin', `refs/heads/${ref}`);
    remote = line ? line.split(/\s+/)[0] : null;
  }
  const stale = Boolean(remote && local !== remote && tryGit(cwd, 'merge-base', '--is-ancestor', remote, local || 'HEAD') === null);
  return { ref, local_sha: local, remote_sha: remote, stale };
}

// First "on X" / "look at X" / "from X" word that is an existing branch.
function mentionedRef(cwd, request) {
  const re = /\b(?:on|at|from|against|branch|ref)\s+(?:the\s+)?([\w][\w./-]*)/gi;
  for (const m of String(request).matchAll(re)) {
    const ref = m[1].replace(/[.,;:]+$/, '');
    if (tryGit(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`)
      || tryGit(cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}`)) return ref;
  }
  return null;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'look', 'please', 'add', 'fix', 'make', 'use']);

// Tracked files whose path contains the most request words (top n).
function relevantFiles(cwd, request, n = 15) {
  const words = [...new Set(String(request).toLowerCase().match(/[a-z0-9]{3,}/g) || [])].filter((w) => !STOP.has(w));
  const files = (tryGit(cwd, 'ls-files') || '').split('\n').filter(Boolean);
  return files
    .map((f) => ({ f, score: words.filter((w) => f.toLowerCase().includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.f.localeCompare(b.f))
    .slice(0, n)
    .map((x) => x.f);
}

const RETRIEVE = path.join(__dirname, 'prefs', 'retrieve.js');

function matchedPrefs(request, files, repoRoot) {
  if (!fs.existsSync(RETRIEVE)) return [];
  return require(RETRIEVE).retrieve({ request, files, repoRoot }).records.map((r) => `${r.id}: ${r.correction}`);
}

const CMD = /(?:`([^`]+)`|\b((?:node|npm|npx|pnpm|yarn|pytest|go test|make (?:test|check)|cargo test)\b[^;,\n]*))/;

// Check command: one named in the request wins, else package.json test script.
function checkCmd(root, request = '') {
  const m = request.match(CMD);
  if (m) return (m[1] || m[2]).replace(/\s+(prints|passes|exits|returns|succeeds)\b.*$/, '').replace(/\.(\s.*)?$/, '').trim();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return pkg.scripts && pkg.scripts.test ? 'npm test' : '';
  } catch {
    return '';
  }
}

// One-shot context, shaped as workflow args.
function context(request, { cwd = process.cwd(), ref, offline = false } = {}) {
  const info = repoInfo(cwd);
  const name = ref || mentionedRef(info.root, request);
  const files = relevantFiles(info.root, request);
  return {
    request,
    ...classify(request, { files }),
    root: info.root,
    base: info.head,
    head: info.head,
    branch: info.branch,
    upstream: info.upstream,
    ref: name ? refStatus(info.root, name, { offline }) : null,
    files,
    prefs: matchedPrefs(request, files, info.root),
    checkCmd: checkCmd(info.root, request),
  };
}

// Steps whose files match a corrected file or area (path prefix); these must be rerun.
function affected(steps, areas) {
  const hit = (f) => areas.some((a) => f === a || f.startsWith(a.endsWith('/') ? a : `${a}/`));
  return steps.filter((s) => (s.files || []).some(hit)).map((s) => s.id);
}

module.exports = { checkCmd, repoInfo, refStatus, mentionedRef, relevantFiles, context, affected };
