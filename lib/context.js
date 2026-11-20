'use strict';
const { execFileSync } = require('node:child_process');

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

module.exports = { repoInfo, refStatus, mentionedRef };
