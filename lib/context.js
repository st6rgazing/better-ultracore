'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { classify } = require('./classify');
const { DEFAULT_LIMITS } = require('./engine');

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

// Compares a local ref with origin (ls-remote). stale = remote tip not contained in local ref.
function refStatus(cwd, ref, { offline = false } = {}) {
  const local = tryGit(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`)
    || tryGit(cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}`);
  let remote = null;
  if (!offline) {
    const line = tryGit(cwd, 'ls-remote', 'origin', `refs/heads/${ref}`);
    remote = line ? line.split(/\s+/)[0] : null;
  }
  const stale = Boolean(remote && local !== remote && tryGit(cwd, 'merge-base', '--is-ancestor', remote, local || 'HEAD') === null);
  const info = { ref, local_sha: local, remote_sha: remote, stale };
  // Fetch only the remote-tracking ref so the content is readable via `git show origin/<ref>:path`.
  // Never touches the working tree, the index or local branches.
  if (stale && tryGit(cwd, 'fetch', '--quiet', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`) !== null) {
    info.read_from = `origin/${ref}`;
  }
  return info;
}

// Files that differ between the local ref and the fetched remote, limited to the files the task touches.
function conflictFiles(cwd, ref, taskFiles) {
  if (!ref.stale || !ref.read_from || !ref.local_sha) return [];
  const changed = new Set((tryGit(cwd, 'diff', '--name-only', `${ref.local_sha}..${ref.read_from}`) || '').split('\n').filter(Boolean));
  return taskFiles.filter((f) => changed.has(f));
}

const FALLBACK = {
  planned: ['Agent better-ultracore:planner: plan only, return steps/files/acceptance', 'Agent better-ultracore:coder: implement the plan, run checkCmd once, max 2 repairs'],
  parallel: ['Agent better-ultracore:planner: split into items with disjoint files', 'One Agent better-ultracore:coder per item, one at a time, each only its own files', 'Run checkCmd once at the end'],
};

// Manual steps for when the Workflow tool is refused; only workflow routes have any.
function fallbackSteps(c) {
  const verify = 'Agent better-ultracore:verifier: give request, git diff <base> and untracked files, run checkCmd fresh';
  if (c.route === 'guarded') {
    const coder = 'Agent better-ultracore:coder: implement, run checkCmd once, max 2 repairs';
    return c.hasCriteria || c.namedFiles === 1 ? [coder, verify] : [FALLBACK.planned[0], coder, verify];
  }
  return FALLBACK[c.route];
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

// Tracked files the request names: full path verbatim, or exact basename.
function explicitFiles(cwd, request) {
  const tokens = new Set(String(request).match(/[\w./-]+/g) || []);
  const files = (tryGit(cwd, 'ls-files') || '').split('\n').filter(Boolean);
  return files.filter((f) => tokens.has(f) || tokens.has(path.basename(f)));
}

const RETRIEVE =path.join(__dirname, 'prefs', 'retrieve.js');

// Advisory prefs and blockers (status "blocker", reduced to their short check string) from matched records.
function matchedPrefs(request, files, repoRoot) {
  if (!fs.existsSync(RETRIEVE)) return { prefs: [], blockers: [] };
  const records = require(RETRIEVE).retrieve({ request, files, repoRoot }).records;
  return {
    prefs: records.filter((r) => r.status !== 'blocker').map((r) => `${r.id}: ${r.correction}`),
    blockers: records.filter((r) => r.status === 'blocker').map((r) => `${r.id}: ${r.check || r.correction}`),
  };
}

const CMD = /(?:`([^`]+)`|\b((?:node|npm|npx|pnpm|yarn|pytest|go test|make (?:test|check)|cargo test)\b[^;,\n]*))/;

// Check command: one named in the request wins, else package.json test script.
function checkCmd(root, request = '') {
  const m = request.match(CMD);
  if (m) return (m[1] || m[2]).replace(/\s+(?:should|must|still|will|to)\b.*\bpass(?:es)?\b.*$/i, '').replace(/\s+(prints|passes|exits|returns|succeeds)\b.*$/, '').replace(/(?<![./])\.(\s.*)?$/, '').trim();
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
  const { prefs, blockers } = matchedPrefs(request, files, info.root);
  // Clock lives here, not in the engine: workflow scripts cannot read it.
  const startedAtMs = Date.now();
  const named = explicitFiles(info.root, request);
  const cls = classify(request, { files: named });
  const refInfo = name ? refStatus(info.root, name, { offline }) : null;
  if (refInfo && refInfo.stale) refInfo.conflict_files = conflictFiles(info.root, refInfo, [...new Set([...named, ...files])]);
  const out = {
    request,
    ...cls,
    root: info.root,
    base: info.head,
    head: info.head,
    branch: info.branch,
    upstream: info.upstream,
    ref: refInfo,
    files,
    prefs,
    blockers,
    startedAtMs,
    deadlineMs: startedAtMs + DEFAULT_LIMITS.maxElapsedMin * 60000,
    checkCmd: checkCmd(info.root, request),
  };
  for (const k of ['prefs', 'files', 'blockers']) if (!out[k].length) delete out[k];
  const steps = fallbackSteps(out);
  if (steps) out.fallback_steps = steps;
  return out;
}

// Steps whose files match a corrected file or area (path prefix); these must be rerun.
function affected(steps, areas) {
  const hit = (f) => areas.some((a) => f === a || f.startsWith(a.endsWith('/') ? a : `${a}/`));
  return steps.filter((s) => (s.files || []).some(hit)).map((s) => s.id);
}

module.exports = { checkCmd, repoInfo, refStatus, mentionedRef, relevantFiles, context, affected };
