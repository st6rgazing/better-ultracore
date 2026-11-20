'use strict';
// UserPromptSubmit: inject matched rules, a stale-ref note and the check command. Offline, no model call.
const { execFileSync } = require('node:child_process');
const { mentionedRef } = require('../lib/context');
const { configuredCmd } = require('../lib/rules/check');
const { retrieve } = require('../lib/rules/retrieve');
const store = require('../lib/rules/store');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };

// Remote-tracking ref already ahead of the local branch (no fetch here).
function staleLine(root, prompt) {
  const ref = mentionedRef(root, prompt);
  if (!ref || tryGit(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`) === null) return '';
  const behind = tryGit(root, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}`) !== null
    && tryGit(root, 'merge-base', '--is-ancestor', `origin/${ref}`, ref) === null;
  return behind ? `origin/${ref} is ahead of local ${ref}: read via git show origin/${ref}:<path> after git fetch` : '';
}

function run(input) {
  const { prompt = '', cwd = process.cwd(), session_id: sessionId } = input;
  const root = tryGit(cwd, 'rev-parse', '--show-toplevel');
  const { matched, kind, block } = retrieve({ prompt, cwd, rules: store.loadRules() });
  const parts = [block];
  if (sessionId && !root) store.clearTurn(sessionId);
  if (root) {
    parts.push(staleLine(root.trim(), prompt));
    const cmd = configuredCmd(root.trim());
    if (cmd && matched.length) parts.push(`Check command: ${cmd}`);
    const checked = matched.filter((r) => r.check.cmd);
    if (sessionId && !checked.length) store.clearTurn(sessionId);
    if (sessionId && checked.length) {
      store.writeTurn(sessionId, {
        session_id: sessionId, cwd, root: root.trim(), prompt, kind, head: tryGit(root.trim(), 'rev-parse', 'HEAD')?.trim() || null,
        porcelain: tryGit(root.trim(), 'status', '--porcelain') || '',
        rules: checked.map((r) => ({ id: r.id, cmd: r.check.cmd })), checks: checked.map((r) => r.check.cmd),
      });
    }
  }
  const text = parts.filter(Boolean).join('\n');
  return text ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } } : null;
}

module.exports = { run };

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; }).on('end', () => {
    try {
      const out = run(JSON.parse(raw));
      if (out) console.log(JSON.stringify(out));
    } catch { /* a hook must never break the prompt */ }
  });
}
