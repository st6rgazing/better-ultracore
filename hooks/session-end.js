'use strict';
// SessionEnd: log short corrective turns to the inbox and bump rules whose keywords they mention. No model call.
const { correctiveTurns } = require('../lib/rules/mine');
const store = require('../lib/rules/store');

function run(input) {
  if (!input.transcript_path) return 0;
  const turns = correctiveTurns(input.transcript_path);
  if (!turns.length) return 0;
  const ts = new Date().toISOString();
  store.appendInbox(turns.map((t) => ({ ts, session_id: t.session_id, text: t.text })));
  const hit = store.loadRules().filter((r) => turns.some((t) => r.when.keywords.some((k) => new RegExp(`\\b${k.replace(/\W/g, '')}\\b`, 'i').test(t.text)))).map((r) => r.id);
  if (hit.length) store.bump(hit);
  return turns.length;
}

module.exports = { run };

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; }).on('end', () => {
    try { run(JSON.parse(raw)); } catch { /* never fail session end */ }
  });
}
