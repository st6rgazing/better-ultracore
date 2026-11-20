'use strict';
// Stop: run the deterministic checks of this turn's matched rules; a failure blocks once so the model revises.
const { checkSession } = require('../lib/rules/check');
const { redact } = require('../lib/prefs/redact');
const store = require('../lib/rules/store');

const MAX_REASON = 600;

function run(input) {
  if (!input.session_id) return null;
  if (input.stop_hook_active) {
    store.clearTurn(input.session_id);
    return null;
  }
  const failed = checkSession(input.session_id).filter((r) => !r.pass);
  if (!failed.length) {
    store.clearTurn(input.session_id);
    return null;
  }
  store.violate(failed.flatMap((r) => r.rules));
  const reason = `Fix before finishing: ${failed.map((r) => `${r.id}: ${r.detail}`).join('; ')}`;
  return { decision: 'block', reason: redact(reason).slice(0, MAX_REASON) };
}

module.exports = { run };

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; }).on('end', () => {
    try {
      const out = run(JSON.parse(raw));
      if (out) console.log(JSON.stringify(out));
    } catch { /* never block on hook errors */ }
  });
}
