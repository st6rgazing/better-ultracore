'use strict';

const { classify } = require('./classify');

const LINE = 'Before finishing, write a throwaway script outside the repo that calls the changed functions with empty, malformed, truncated and boundary inputs, run it, and fix anything that misbehaves.';
const RISKY = /\b(pars(?:e|es|ed|ing)|validat(?:e|es|ed|ion|ing)|verif(?:y|ies|ied|ication)|hash(?:es|ed|ing)?|password|token|decod(?:e|es|ed|ing)|sanitiz(?:e|es|ed|ing)|sanitis(?:e|es|ed|ing))\b/i;
const EFFECT_LINE = 'This adds a runtime effect: read every guard on the call (init, unlock, mute, permission, flag) and confirm it fires when called; if you could not run it, say so.';
const EFFECT = /\b(sounds?|audio|music|sfx|vibrat\w*|haptics?|notifications?|toasts?|autoplay|animations?|clipboard)\b/i;
const CHANGE = /\b(add|fix|change|update|implement|create|refactor|rename|remove|write|build|make|replace|migrate|rewrite|switch|harden)\b/i;

function probeLine(prompt) {
  const text = String(prompt || '');
  const risky = RISKY.test(text);
  if ((!risky && !EFFECT.test(text)) || !CHANGE.test(text)) return '';
  if (classify(text).route === 'review') return '';
  return risky ? LINE : EFFECT_LINE;
}

module.exports = { probeLine };
