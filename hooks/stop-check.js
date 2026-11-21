'use strict';
// Stop: run this turn's checks. A failed hard check blocks once so the model revises; a failed soft check
// is returned as additionalContext (feedback, not an error). One continuation per turn: nothing runs when stop_hook_active.
const { checkSession, turnFiles } = require('../lib/rules/check');
const { redact } = require('../lib/prefs/redact');
const store = require('../lib/rules/store');

const MAX_REASON = 600;

// Keeps what this turn changed, {head, files}, in the last-turn record so the next prompt can ask for it to be undone.
function remember(sessionId) {
  try {
    const turn = store.readTurn(sessionId);
    if (!turn || !turn.root || !('porcelain' in turn)) return;
    store.saveLastTurn(sessionId, { head: turn.head || null, files: turnFiles(turn.root, turn) });
  } catch { /* best effort */ }
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
  const notes = failed.filter((r) => r.soft).map((r) => r.detail);
  if (hard.length) {
    store.violate(hard.flatMap((r) => r.rules));
    const reason = [`Fix before finishing: ${hard.map((r) => `${r.id}: ${r.detail}`).join('; ')}`, ...notes].join('. Also: ');
    return { decision: 'block', reason: redact(reason).slice(0, MAX_REASON) };
  }
  if (!notes.length) {
    store.clearTurn(sessionId);
    return null;
  }
  return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: redact(notes.join('\n')).slice(0, MAX_REASON) } };
}

module.exports = { run, remember };

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; }).on('end', () => {
    try {
      const out = run(JSON.parse(raw));
      if (out) console.log(JSON.stringify(out));
    } catch { /* never block on hook errors */ }
  });
}
