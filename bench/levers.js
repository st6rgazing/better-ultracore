'use strict';
// Per-lever accounting for bench/replay.js: what each kind of injected line costs in tokens and how many of the
// corrections that followed it it is meant to prevent. Self-repair work argues for exactly this: keep a check only
// if it pays for its tokens. Offline, so the number is an upper bound: the lever was shown before a correction of
// the kind it targets; whether the agent would have obeyed it is not measured.
const { probeLine } = require('../lib/probe');
const orchestrate = require('../lib/orchestrate');

const CHARS_PER_TOKEN = 4;
const ORCHESTRATE = [orchestrate.SOLO, orchestrate.SIZED, orchestrate.NOT_OPTIN, orchestrate.MIDTURN];

// Splits the text the prompt hook injected into chars per lever: rules (the header and its "- " lines), orchestrate,
// check, typecheck, stale, shot, probe, and intent for whatever line is left (the reading or correction line).
function leversOf(text, prompt = '') {
  const out = {};
  const add = (name, line) => { out[name] = (out[name] || 0) + line.length + 1; };
  const probe = probeLine(prompt);
  let inRules = false;
  for (const line of String(text || '').split('\n').filter(Boolean)) {
    if (line.startsWith('Background from the user\'s past sessions')) { inRules = true; add('rules', line); continue; }
    if (inRules && line.startsWith('- ')) { add('rules', line); continue; }
    inRules = false;
    if (ORCHESTRATE.includes(line)) add('orchestrate', line);
    else if (line.startsWith('Check command: ')) add('check', line);
    else if (line.startsWith('The typecheck runs automatically')) add('typecheck', line);
    else if (/^origin\/\S+ is ahead of local|^You named \S+: run git fetch/.test(line)) add('stale', line);
    else if (line.startsWith('After editing, run node ')) add('shot', line);
    else if (probe && line === probe) add('probe', line);
    else add('intent', line);
  }
  return out;
}

module.exports = { leversOf, CHARS_PER_TOKEN };
