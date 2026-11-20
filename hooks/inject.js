'use strict';
// UserPromptSubmit: inject matched rules, a stale-ref note and the check command. Offline, no model call.
const { execFileSync } = require('node:child_process');
const { mentionedRef } = require('../lib/context');
const { configuredCmd, typecheckCmd } = require('../lib/rules/check');
const path = require('node:path');
const { retrieve, render } = require('../lib/rules/retrieve');
const { redact } = require('../lib/prefs/redact');
const store = require('../lib/rules/store');
const feedback = require('../lib/rules/feedback');
const { intentLine, correctionLine } = require('../lib/intent');
const fs = require('node:fs');
const { probeLine } = require('../lib/probe');

const MAX_CONTEXT = 800;

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

// True when this session already had an assistant turn (resumed or follow-up prompt).
function hadPreviousTurn(sessionId, transcriptPath) {
  if (sessionId && store.loadLastTurn(sessionId)) return true;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const { size } = fs.fstatSync(fd);
    const n = Math.min(size, 65536);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    fs.closeSync(fd);
    return buf.toString('utf8').includes('"type":"assistant"');
  } catch { return false; }
}

// Fixed lines get at most MAX_FIXED chars so rules keep room; drop in the given order (verify, probe, intent).
const MAX_FIXED = 500;
function capFixed(fixed, dropOrder) {
  const size = () => fixed.filter(Boolean).join('\n').length;
  for (const line of dropOrder) {
    if (size() <= MAX_FIXED) return;
    const i = line ? fixed.indexOf(line) : -1;
    if (i >= 0) fixed[i] = '';
  }
}

// Keep the top rules that fit beside the fixed lines; the lowest-score rules go first.
function fit(matched, fixed) {
  for (let n = matched.length; n >= 0; n--) {
    const kept = matched.slice(0, n);
    const block = render(kept);
    const kn = block ? block.split('\n').length - 1 : 0;
    const text = [block, ...fixed].filter(Boolean).join('\n');
    if (text.length <= MAX_CONTEXT || n === 0) return { kept: kept.slice(0, kn), block: n === 0 ? '' : block };
  }
  return { kept: [], block: '' };
}

function run(input) {
  const { prompt = '', cwd = process.cwd(), session_id: sessionId, transcript_path: transcriptPath } = input;
  const hadPrev = hadPreviousTurn(sessionId, transcriptPath);
  const root = tryGit(cwd, 'rev-parse', '--show-toplevel');
  const repo = root ? path.basename(root.trim()) : null;
  try { feedback.onPrompt({ prompt, sessionId, repo }); } catch { /* feedback is best effort */ }
  const { matched: all, kind } = retrieve({ prompt, cwd, rules: store.loadRules(), repo });
  const fixed = [];
  if (root) {
    fixed.push(staleLine(root.trim(), prompt));
    const cmd = configuredCmd(root.trim());
    if (cmd && all.length) fixed.push(`Check command: ${cmd}`);
  }
  const tc = root && kind !== 'advice' ? typecheckCmd(root.trim()) : '';
  if (tc) fixed.push(`Verify with ${tc} (not npx); report what you ran.`);
  const intent = correctionLine(prompt, hadPrev) || intentLine(prompt, { kind });
  fixed.push(intent, probeLine(prompt));
  capFixed(fixed, [tc && fixed.find((l) => l.startsWith('Verify with')), fixed[fixed.length - 1], intent]);
  const { kept: matched, block } = fit(all, fixed.filter(Boolean));
  if (sessionId) store.saveLastTurn(sessionId, { rules: matched.map((r) => r.id), repo, ts: Date.now() });
  if (sessionId && !root) store.clearTurn(sessionId);
  if (root) {
    const checked = matched.filter((r) => r.check.cmd);
    const checks = [...checked.map((r) => r.check.cmd), ...(tc ? ['typecheck'] : [])];
    if (sessionId && !checks.length) store.clearTurn(sessionId);
    if (sessionId && checks.length) {
      store.writeTurn(sessionId, {
        session_id: sessionId, cwd, root: root.trim(), prompt: redact(prompt), kind, head: tryGit(root.trim(), 'rev-parse', 'HEAD')?.trim() || null,
        porcelain: tryGit(root.trim(), 'status', '--porcelain') || '',
        rules: checked.map((r) => ({ id: r.id, cmd: r.check.cmd })), checks,
      });
    }
  }
  const text = [block, ...fixed].filter(Boolean).join('\n');
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
