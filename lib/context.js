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

module.exports = { repoInfo };
