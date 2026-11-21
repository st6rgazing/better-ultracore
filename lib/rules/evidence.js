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

module.exports = { claims };
