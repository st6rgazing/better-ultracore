'use strict';
// UserPromptSubmit: inject matched rules, a stale-ref note and the check command. Offline, no model call.
const { execFileSync } = require('node:child_process');
const { mentionedRef } = require('../lib/context');
const { configuredCmd } = require('../lib/rules/check');
const { retrieve } = require('../lib/rules/retrieve');
const { redact } = require('../lib/prefs/redact');
const store = require('../lib/rules/store');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };

// A named branch with an origin remote: point at the remote truth. No network in the hook; the model fetches.
function staleLine(root, prompt) {
  const ref = mentionedRef(root, prompt);
  if (!ref || tryGit(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`) === null) return '';
  if (tryGit(root, 'remote', 'get-url', 'origin') === null) return '';
  const known = tryGit(root, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}`) !== null;
  if (known && tryGit(root, 'merge-base', '--is-ancestor', `origin/${ref}`, ref) === null) {
    return `origin/${ref} is ahead of local ${ref}: read via git show origin/${ref}:<path> after git fetch`;
  }
  return `You named ${ref}: run git fetch origin ${ref} (read-only for the checkout), then read files via git show origin/${ref}:<path> and cite the remote SHA. Do not use the local copy.`;
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
        session_id: sessionId, cwd, root: root.trim(), prompt: redact(prompt), kind, head: tryGit(root.trim(), 'rev-parse', 'HEAD')?.trim() || null,
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
