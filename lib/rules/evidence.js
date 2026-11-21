'use strict';
// Stop checks that compare what the reply claims with the turn's tool log (lib/turnlog.js, written by hooks/track.js).
// Sources: reports of work called verified when steps had failed, and Self-Debugging (execution feedback beats self-report).

const TESTS_CLAIM = /\b(tests?|test suite|specs?)\b( \w+){0,2}? (pass(es|ed|ing)?|(is|are|were) (all |now |still )?(passing|green))\b|\ball (\d+ )?(tests|specs) (pass|are green|green)|\b\d+ (of|\/) ?\d+ (tests )?pass/i;
const VERIFIED_CLAIM = /\b(i|i've|i have|we|we've|we have) (also |then |have |just )*(verified|confirmed|tested)\b|^\W*(verified|confirmed|tested)\b|\bverified (that|by|with|locally|end)/i;
// A sentence that plans, asks, doubts or denies is not a claim.
const HEDGE = /\b(not|never|unverified|untested|should|will|would|could|might|may|if|once|when|until|whether|make sure|ensure|please|you can|cannot|unable|without|before|to (verify|confirm|test|check))\b|n't\b|\?\s*$/i;

// What a reply claims as done: {tests, verified}. Code blocks and quoted lines are left out.
function claims(reply) {
  const prose = String(reply || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/^\s*>.*$/gm, ' ');
  const sentences = prose.split(/(?<=[.!?:;])\s+|\n+/).filter((s) => s.trim() && !HEDGE.test(s));
  return { tests: sentences.some((s) => TESTS_CLAIM.test(s)), verified: sentences.some((s) => VERIFIED_CLAIM.test(s)) };
}

const result = (id, pass, detail = '', soft = false) => ({ id, pass, detail, soft, rules: [] });
const NO_TEST = 'Your reply says tests pass, but no test command ran this turn. Run them now and quote the result line, or say plainly that tests were not run.';
const TEST_FAILED = 'Your reply says tests pass, but the last test run this turn failed. Fix it and rerun, or report the failure as it is.';
const NO_RUN = 'Your reply says verified, but nothing ran after your last edit. Say what you ran and saw for each claim, or mark it unverified.';
const DELEGATED = 'Your reply says tests pass on a subagent\'s word. Run the test command yourself once and quote the result line, or say it is unverified.';

// Hard, id unbacked-claim (a BUC_OFF name). The reply states a result the tool log does not back:
// tests pass with a failed last test run, or with edits and no run after them; verified with no tool call after the last edit.
// Passes when the tool hook saw nothing this turn (no log to judge by) and when the turn made no edit and had no failed run.
// A claim resting on a subagent (agents > 0) is soft: its calls are not in the log.
function unbacked(turn, input) {
  const id = 'unbacked-claim';
  const calls = Number(turn.toolCalls) || 0;
  if (!calls) return result(id, true);
  const said = claims(input && input.last_assistant_message);
  const edit = Number(turn.lastEditAt) || 0;
  if (said.tests && turn.lastTestAt && turn.lastTestOk === false) return result(id, false, TEST_FAILED);
  if (said.tests && edit && !turn.lastTestAt && !(Number(turn.lastRunAt) > edit)) {
    return Number(turn.agents) > 0 ? result(id, false, DELEGATED, true) : result(id, false, NO_TEST);
  }
  if (said.verified && edit && calls <= edit && !(Number(turn.agents) > 0)) return result(id, false, NO_RUN);
  return result(id, true);
}

module.exports = { claims, unbacked };
