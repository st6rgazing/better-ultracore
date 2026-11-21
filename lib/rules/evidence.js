'use strict';
const store = require('./store');
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

const BUGFIX = /\b(bugs?|fix(es|ed|ing)?|broken|crash(es|ed|ing)?|errors?|fails?|failing|failure|regression|not working|doesn'?t work|exception|stack ?trace|wrong (result|output|value))\b/i;
// A fix to wording or looks has nothing to execute.
const NOTHING_TO_RUN = /\b(typos?|spelling|wording|copy|text|label|readme|docs?|comments?|css|styl\w+|colou?rs?|fonts?|padding|margins?|spacing|layout|align\w*|icons?)\b/i;
const ADMITS = /\b(unverified|untested|not (run|verified|tested)|did not run|didn'?t run|could not run|couldn'?t run|have not run|haven'?t run)\b/i;
const UNRUN = 'You changed code for a bug report and ran nothing after your last edit. Run a failing case or the tests now, or say in one line that the fix is unverified.';

// Soft, id edit-unrun (a BUC_OFF name). Agentless: a fix is judged by a reproduction, not by reading the patch.
// Fires on a bug-fix edit prompt when the log shows an edit and no executing command after it, and the reply does not already say so.
function unrun(turn, input) {
  const id = 'edit-unrun';
  const prompt = String(turn.prompt || '');
  const edit = Number(turn.lastEditAt) || 0;
  const applies = turn.kind === 'edit' && edit && !['SHOW', 'HANDSOFF', 'UNDO'].includes(turn.intent) && BUGFIX.test(prompt) && !NOTHING_TO_RUN.test(prompt);
  if (!applies || Number(turn.lastRunAt) > edit || Number(turn.agents) > 0) return result(id, true);
  if (ADMITS.test(String((input && input.last_assistant_message) || ''))) return result(id, true);
  return result(id, false, UNRUN, true);
}

// The evidence checks of this session's turn, for the Stop hook: results shaped like checkSession's. [] with no turn file.
// edit-unrun is left out when unbacked-claim already failed (one message for one gap).
function stopChecks(sessionId, input = {}) {
  const turn = store.readTurn(sessionId);
  if (!turn) return [];
  const root = turn.root || turn.cwd || input.cwd || process.cwd();
  const out = [];
  if (!store.off('unbacked-claim', root)) out.push(unbacked(turn, input));
  if (!store.off('edit-unrun', root) && !out.some((r) => !r.pass)) out.push(unrun(turn, input));
  return out;
}

module.exports = { claims, unbacked, unrun, stopChecks };
