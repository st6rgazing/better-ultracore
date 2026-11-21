'use strict';

const { classify } = require('./classify');
const { isCorrection } = require('./rules/feedback');

const LITERAL = 'Read the request literally: make the smallest change that fully meets it, no narrower and no wider; touch only what is named';
const SHOW = 'This asks to show or explain: answer in text and do not edit files.';
const SWEEP_LINE = 'This asks for a sweep: git grep the whole repo for every occurrence, fix each one, then grep again to confirm none remain.';
const SWEEP = /\b(whole (app|project|repo|codebase|site)|everywhere|throughout|all (traces|instances|occurrences|mentions|references)|every (page|screen|file|place|occurrence))\b/i;
const VAGUE_LINE = 'The request names no defect: work out what the user dislikes from any pasted text and the standing corrections above, and fix that across the whole screen; a cosmetic tweak is not enough.';
const VAGUE = /^\s*(can (u|you) |pls |please )?(fix|improve|clean up|tidy( up)?|redo) (the |my |this )?([\w-]+ ){0,2}(screen|page|dialog|form|modal|view|ui|menu)\s*\??\s*$/i;
const E2E = 'Deliver this where the user will see it: trace from the app entry to the screen or path they mean, wire it in, and update copy or tests that state the old behaviour.';
const ASSUME = ' If ambiguous, pick the likeliest reading, name it in your first line; do not ask.';
const NARROW = /\b(only|just|minimal|nothing else|leave\b.{0,30}\balone|don'?t touch|do not touch)\b/i;
const SPECIFIC = /\b(change|rename|replace|swap|set|turn)\b[^.\n]{1,60}?\b(to|into|with)\b/i;
const PATHLIKE = /[\w-]+\.[a-z]{1,4}\b|\w\/\w/i;
const STEP = 'change by a small step only';
const DEGREE = /\b(slightly|a little|a bit|bit|smaller|bigger|more|less)\b/i;
const CRITERIA = /\bacceptance\b|\b(should|must)\b|\b(npm (?:run )?test|node --test|pytest|go test|cargo test)\b|^\s*[-*]\s/im;
const MAX_WORDS = 60;

function stripPasted(text) {
  return text.replace(/<pasted[^>]*>[\s\S]*?<\/pasted>/gi, ' ');
}

function intentLine(prompt, { kind } = {}) {
  const text = stripPasted(String(prompt || '')).trim();
  if (!text) return '';
  if (text.split(/\s+/).length > MAX_WORDS) return '';
  if (CRITERIA.test(text)) return '';
  const advice = kind === 'review' || (kind === undefined && classify(text).route === 'review');
  if (advice) return SHOW;
  if (VAGUE.test(text)) return VAGUE_LINE;
  if (SWEEP.test(text)) return SWEEP_LINE;
  if (NARROW.test(text) || DEGREE.test(text) || PATHLIKE.test(text) || SPECIFIC.test(text)) return LITERAL + (DEGREE.test(text) ? '; ' + STEP : '') + '.';
  return E2E + (text.split(/\s+/).length <= 25 ? ASSUME : '');
}

const STILL = /^\s*still\b|\b(doesn'?t|didn'?t|does not|did not|isn'?t|not) work|\bstill (broken|wrong|not|fails?)\b|\bno longer works?\b/i;
const UNDO_SHOW = /\b(undo|revert)\b[\s\S]*\b(show|tell|explain)\b|\bjust (show|tell)\b/i;
const STILL_LINE = 'Your last change is still wrong from the user\'s view. Re-read their original words, run or trace the exact screen they mean, keep what was right and fix what they still see. Say in one line what was wrong.';
const UNDO_LINE = 'This corrects your last turn: restore only the files you changed (git checkout -- <file>, or delete files you created), then answer in text only with exact steps.';
const MISREAD_LINE = 'This corrects your last turn. Do not defend it or ask: take the most likely different reading of the original request, redo it that way, undo only what conflicts, and open with one line naming the new reading.';

// Follow-up turns: replaces the intent line when the prompt corrects the previous turn.
function correctionLine(prompt, hadPrev) {
  const text = stripPasted(String(prompt || '')).trim();
  if (!hadPrev || !text) return '';
  if (STILL.test(text)) return STILL_LINE;
  if (!isCorrection(text)) return '';
  return UNDO_SHOW.test(text) ? UNDO_LINE : MISREAD_LINE;
}

module.exports = { intentLine, correctionLine };
