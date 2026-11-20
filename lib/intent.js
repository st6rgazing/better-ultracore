'use strict';

const { classify } = require('./classify');

const LITERAL = 'Read the request literally: make the smallest change that fully meets it, no narrower and no wider; touch only what is named';
const SHOW = 'This asks to show or explain: answer in text and do not edit files.';
const SWEEP_LINE = 'This asks for a sweep: git grep the whole repo for every occurrence, fix each one, then grep again to confirm none remain.';
const SWEEP = /\b(whole (app|project|repo|codebase|site)|everywhere|throughout|all (traces|instances|occurrences|mentions|references)|every (page|screen|file|place|occurrence))\b/i;
const VAGUE_LINE = 'The request names no defect: work out what the user dislikes from any pasted text and the standing corrections above, and fix that across the whole screen; a cosmetic tweak is not enough.';
const VAGUE = /^\s*(can (u|you) |pls |please )?(fix|improve|clean up|tidy( up)?|redo) (the |my |this )?([\w-]+ ){0,2}(screen|page|dialog|form|modal|view|ui|menu)\s*\??\s*$/i;
const E2E = 'Make the smallest change that fully delivers this where the user will see it: trace from the app entry to the screen or code path they mean before picking a file, wire it in, and update copy or tests that state the old behaviour.';
const ASSUME = ' If it is ambiguous, pick the likeliest reading, name it in your first line, and do not ask.';
const NARROW = /\b(only|just|minimal|nothing else|leave\b.{0,30}\balone|don'?t touch|do not touch)\b/i;
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
  if (NARROW.test(text) || DEGREE.test(text) || PATHLIKE.test(text)) return LITERAL + (DEGREE.test(text) ? '; ' + STEP : '') + '.';
  return E2E + (text.split(/\s+/).length <= 25 ? ASSUME : '');
}

module.exports = { intentLine };
