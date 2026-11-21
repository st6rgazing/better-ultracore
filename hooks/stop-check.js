'use strict';
// Stop: run this turn's checks. A failed hard check blocks once so the model revises; a failed soft check
// is returned as additionalContext (feedback, not an error). One continuation per turn: nothing runs when stop_hook_active.
// When UI files changed and the agent took no screenshot, the hook takes one (45 s at most) and hands over the PNG path.
const fs = require('node:fs');
const path = require('node:path');
const { checkSession, turnFiles, changedFiles, addedLines, freshNames } = require('../lib/rules/check');
const { shotSync, resolveServer, isUiFile, classesIn, styledClassesIn } = require('../lib/shot');
const { redact } = require('../lib/prefs/redact');
const store = require('../lib/rules/store');

const MAX_REASON = 600;
const MAX_CONTEXT = 900;
const SHOT_MS = 45000;

// Keeps what this turn changed, {head, files}, in the last-turn record so the next prompt can ask for it to be undone.
function remember(sessionId) {
  try {
    const turn = store.readTurn(sessionId);
    if (!turn || !turn.root || !('porcelain' in turn)) return;
    store.saveLastTurn(sessionId, { head: turn.head || null, files: turnFiles(turn.root, turn) });
  } catch { /* best effort */ }
}

// The fallback screenshot: UI files changed this turn, no buc-shot was run, and the repo has a dev server to start.
// Returns the feedback line, or '' when there is nothing to show (also when the screenshot was skipped). BUC_OFF name: shot.
// A screenshot is handed over only with evidence that it shows the change: the turn introduced classes or changed
// the style rule of some, and the captured page has at least one of those. A page without them (another route, a loader, a blank frame) says nothing
// about the change and would cost a turn, so the hook stays quiet and removes the image.
// The line is already redacted where it quotes the page; the PNG path must stay as it is.
function fallbackShot(sessionId) {
  try {
    const turn = store.readTurn(sessionId);
    if (!turn || !turn.root || !('porcelain' in turn) || turn.shotAt || turn.kind === 'advice') return '';
    const root = turn.root;
    if (store.off('shot', root)) return '';
    const ui = changedFiles(root, turn).filter((f) => isUiFile(f) && fs.existsSync(path.join(root, f)));
    if (!ui.length || resolveServer(root, 0).skip) return '';
    const lines = addedLines(root, turn, ui);
    // Evidence is a class the turn introduced (it marks what the turn built) or one whose style rule it changed (the
    // restyled element). An old class on new markup is neither: it is on the page with or without the change.
    const classes = [...new Set([...freshNames(root, turn, classesIn(lines)), ...styledClassesIn(lines)])];
    if (!classes.length) return '';
    const r = shotSync({ root, path: '/', audit: true, classes, timeoutMs: SHOT_MS });
    if (r.status !== 'ok') return '';
    if (!Array.isArray(r.seen) || !r.seen.length) {
      fs.rmSync(r.png, { force: true });
      return '';
    }
    store.patchTurn(sessionId, { shotAt: store.now() });
    const audit = r.findings.length ? redact(` Layout audit: ${r.findings.join('; ')}.`) : '';
    const shows = r.seen.slice(0, 3).map((c) => `.${c}`).join(', ');
    return `You changed UI files and took no screenshot. Here is ${r.url} after your change, showing ${shows}: ${r.png} . Read it once, check it shows what was asked and fix what does not.${audit}`;
  } catch {
    return '';
  }
}

function run(input) {
  const sessionId = input.session_id;
  if (!sessionId) return null;
  remember(sessionId);
  if (input.stop_hook_active) {
    store.clearTurn(sessionId);
    return null;
  }
  const failed = checkSession(sessionId, input).filter((r) => !r.pass);
  const hard = failed.filter((r) => !r.soft);
  const notes = failed.filter((r) => r.soft).map((r) => redact(r.detail));
  if (hard.length) {
    store.violate(hard.flatMap((r) => r.rules));
    const reason = [`Fix before finishing: ${hard.map((r) => `${r.id}: ${r.detail}`).join('; ')}`, ...notes].join('. Also: ');
    return { decision: 'block', reason: redact(reason).slice(0, MAX_REASON) };
  }
  const seen = fallbackShot(sessionId);
  if (seen) notes.push(seen);
  if (!notes.length) {
    store.clearTurn(sessionId);
    return null;
  }
  return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: notes.join('\n').slice(0, MAX_CONTEXT) } };
}

module.exports = { run, remember, fallbackShot };

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; }).on('end', () => {
    try {
      const out = run(JSON.parse(raw));
      if (out) console.log(JSON.stringify(out));
    } catch { /* never block on hook errors */ }
  });
}
