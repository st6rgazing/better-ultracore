'use strict';

const { classify } = require('./classify');

const LITERAL = 'Read the request literally: make the smallest change that fully meets it, no narrower and no wider; touch only what is named';
const SHOW = 'This asks to show or explain: answer in text and do not edit files.';
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
  return LITERAL + (DEGREE.test(text) ? '; ' + STEP : '') + '.';
}

module.exports = { intentLine };
