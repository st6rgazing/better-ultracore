'use strict';
// SessionEnd: log short corrective turns to the inbox and bump rules whose keywords they mention. No model call.
const { correctiveTurns } = require('../lib/rules/mine');
const store = require('../lib/rules/store');

function run(input) {
  if (!input.transcript_path) return 0;
  const turns = correctiveTurns(input.transcript_path);
  if (!turns.length) return 0;
  // ts is the turn's own time; the session-end time is only a fallback for transcripts without timestamps.
  const ended = new Date(store.now()).toISOString();
  const source = (t) => ({ session: t.session_id, repo: t.repo, ts: t.ts || ended, h: t.h });
  store.appendInbox(turns.map((t) => ({ ts: t.ts || ended, session_id: t.session_id, text: t.text, repo: t.repo, h: t.h })));
  const hits = {};
  for (const r of store.loadRules()) {
    const words = r.when.keywords.map((k) => k.replace(/\W/g, '')).filter(Boolean);
    const sessions = turns.filter((t) => words.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(t.text))).map(source);
    if (sessions.length) hits[r.id] = sessions;
  }
  if (Object.keys(hits).length) store.bumpSessions(hits);
  return turns.length;
}

module.exports = { run };

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; }).on('end', () => {
    try { run(JSON.parse(raw)); } catch { /* never fail session end */ }
  });
}
