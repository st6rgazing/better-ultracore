'use strict';
// Simulated user: deterministic, no model. Never sees accept output.
const BEST_READING = 'use your best reading of what I asked';
const READ_AGAIN = 'no, read what i asked again';

function endsInQuestion(text) {
  return typeof text === 'string' && /\?\s*$/.test(text.trim());
}

// first: result of the initial run. resume(prompt) -> run result; accept() -> boolean; followup: string|null.
// At most 2 correction rounds. Each reply counts as one intervention.
function simulate({ first, resume, accept, followup = null, maxRounds = 2 }) {
  const runs = [first];
  let pass = accept();
  const firstTry = pass;
  let interventions = 0;
  for (let round = 0; !pass && round < maxRounds; round++) {
    const last = runs[runs.length - 1];
    const reply = endsInQuestion(last && last.result) ? BEST_READING : (round === 0 && followup ? followup : READ_AGAIN);
    runs.push(resume(reply));
    interventions += 1;
    pass = accept();
  }
  return { first_try_pass: firstTry, final_pass: pass, interventions, runs };
}

module.exports = { simulate, endsInQuestion, BEST_READING, READ_AGAIN };
