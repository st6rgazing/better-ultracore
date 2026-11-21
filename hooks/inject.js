'use strict';
// UserPromptSubmit: inject matched rules, a stale-ref note and the check command. Offline, no model call.
const { execFileSync } = require('node:child_process');
const { mentionedRef, repoKey } = require('../lib/context');
const { configuredCmd, typecheckCmd } = require('../lib/rules/check');
const path = require('node:path');
const { retrieve, render } = require('../lib/rules/retrieve');
const { redact } = require('../lib/prefs/redact');
const store = require('../lib/rules/store');
const feedback = require('../lib/rules/feedback');
const habits = require('../lib/rules/habits');
const { readIntent, intentMode, readCorrection, SELF, SELF_SHORT, HANDSOFF_LINE, isUiPrompt, uiServer, shotLine } = require('../lib/intent');
const handsoff = require('../lib/handsoff');
const fs = require('node:fs');
const { probeLine } = require('../lib/probe');
const orchestrate = require('../lib/orchestrate');
const votes = require('../lib/rules/votes');

const MAX_CONTEXT = 800;
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
// The Stop hook runs the typecheck; telling the agent to run it too doubled the wall time.
const TYPECHECK_LINE = 'The typecheck runs automatically when you finish; do not run it yourself.';

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

// Fixed lines get at most MAX_FIXED chars so rules keep room. The self-classification line first gives way to its
// short form; after that lines drop in the given order (typecheck, screenshot, probe, intent).
const MAX_FIXED = 500;
function capFixed(fixed, dropOrder) {
  const size = () => fixed.filter(Boolean).join('\n').length;
  if (size() > MAX_FIXED && fixed.includes(SELF)) fixed[fixed.indexOf(SELF)] = SELF_SHORT;
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
  const repo = root ? repoKey(root.trim()) : null;
  try { feedback.onPrompt({ prompt, sessionId, repo }); } catch { /* feedback is best effort */ }
  habits.capture(prompt, repo);
  const { matched: found, kind } = retrieve({ prompt, cwd, rules: store.loadRules(), repo });
  // At most 3 rules reach the prompt, best first (lib/rules/votes.js).
  const all = votes.cap(found, root ? root.trim() : cwd);
  const fixed = [];
  if (root) {
    fixed.push(staleLine(root.trim(), prompt));
    const cmd = configuredCmd(root.trim());
    if (cmd && all.length) fixed.push(`Check command: ${cmd}`);
  }
  // Hands-off repo: every edit prompt gets steps instead of edits, corrections included; only an apply goes through.
  const handsOff = Boolean(repo) && kind === 'edit' && !handsoff.isApply(prompt) && handsoff.active(repo, { root: root.trim() });
  const tc = root && kind !== 'advice' ? typecheckCmd(root.trim()) : '';
  if (tc && !handsOff) fixed.push(TYPECHECK_LINE);
  const correction = readCorrection(prompt, hadPrev);
  const reading = handsOff ? { name: 'HANDSOFF', line: HANDSOFF_LINE } : correction.line ? correction : readIntent(prompt, { kind, mode: intentMode(root ? root.trim() : cwd) });
  const intent = reading.line;
  // A first-turn UI edit with a dev server to shoot: tell the agent how to look at the result.
  const shot = root && kind === 'edit' && !handsOff && !correction.line && !handsoff.isApply(prompt) && isUiPrompt(prompt) && uiServer(root.trim()) ? shotLine(PLUGIN_ROOT) : '';
  const probe = handsOff ? '' : probeLine(prompt);
  // The turn file still holds the previous turn here: agents it launched and no Stop since means this prompt arrives mid-run.
  const orch = handsOff ? '' : orchestrate.line(prompt, { turn: sessionId ? store.readTurn(sessionId) : null, root: root ? root.trim() : cwd });
  fixed.push(intent, probe, shot, orch);
  capFixed(fixed, [tc && TYPECHECK_LINE, shot, probe, orch, intent, SELF_SHORT]);
  // A learned rule is worth more than the long form of the self-classification line.
  if (fixed.includes(SELF) && fit(all, fixed.filter(Boolean)).kept.length < all.length) fixed[fixed.indexOf(SELF)] = SELF_SHORT;
  // At least the top rule is shown: the typecheck, screenshot and probe lines give way to it, the intent line does not.
  for (const line of [tc && TYPECHECK_LINE, shot, probe]) {
    if (!all.length || fit(all, fixed.filter(Boolean)).kept.length) break;
    if (line && fixed.includes(line)) fixed[fixed.indexOf(line)] = '';
  }
  const { kept: matched, block } = fit(all, fixed.filter(Boolean));
  // Read before saveLastTurn starts the new record: the files the previous turn changed, for the undo check.
  const prev = sessionId ? store.loadLastTurn(sessionId) : null;
  if (sessionId) store.saveLastTurn(sessionId, { rules: matched.map((r) => r.id), repo, ts: store.now() });
  if (sessionId && !root) store.clearTurn(sessionId);
  if (root && sessionId) {
    // Written on every prompt in a repo, also with no checks: the Stop and tool hooks read intent, ui and the baseline.
    const checked = matched.filter((r) => r.check.cmd);
    const shown = fixed.includes(intent) || (intent === SELF && fixed.includes(SELF_SHORT));
    store.writeTurn(sessionId, {
      session_id: sessionId, cwd, root: root.trim(), prompt: redact(prompt), kind, head: tryGit(root.trim(), 'rev-parse', 'HEAD')?.trim() || null,
      porcelain: tryGit(root.trim(), 'status', '--porcelain') || '',
      rules: checked.map((r) => ({ id: r.id, cmd: r.check.cmd })), checks: [...checked.map((r) => r.check.cmd), ...(tc ? ['typecheck'] : [])],
      intent: shown ? reading.name : '', ui: Boolean(shot) && fixed.includes(shot), toolCalls: 0, shotAt: 0,
      ...(prev && prev.files && { prevFiles: prev.files }),
    });
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
