'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { classify } = require('./classify');
const { isCorrection } = require('./rules/feedback');
const { isApply } = require('./handsoff');
const store = require('./rules/store');

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

// v10. The model names its own reading; a fixed line is kept only for the patterns in PRECISE.
const SELF = 'Before editing, decide which this is and name it in your first line: EXACT (a named thing takes a stated value: change only that, where the user sees it), FEATURE (trace from the app entry to the screen they mean, wire it in, update copy or tests stating the old behaviour), SWEEP (grep the repo, fix every hit, grep again) or SHOW (answer in text, edit nothing). If two readings remain, pick the likeliest; do not ask.';
// Same four readings in fewer words, for when SELF would push the fixed lines over their cap.
const SELF_SHORT = 'Name your reading in your first line, then act on it: EXACT (change only the named thing), FEATURE (wire it in from the app entry, update stale copy and tests), SWEEP (grep, fix every hit, grep again) or SHOW (text only, no edits). Do not ask.';
// Narrower than the v9 patterns: a comparative or an explicit small amount, and a real file path.
const DEGREE_PRECISE = /\bslightly\b|\ba (bit|tad|touch)\b(?! of\b)|\ba little( bit)?( (more|less|too|\w+er))?\s*([.,!?]|$)|\ba little( bit)? (more|less|\w{3,}er)\b|\b(smaller|bigger|larger|wider|narrower|taller|lighter|darker|thinner|thicker|tighter|looser|brighter|dimmer|quieter|louder)\b/i;
const FILEPATH = /(^|[\s"'`(])[\w.-]*[\w-]\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|css|scss|html|vue|svelte|json|ya?ml|toml|md|sh|sql)\b|(^|[\s"'`(])[\w.-]+\/[\w.-]+\/[\w./-]+|(^|[\s"'`(])(src|lib|app|test|tests|docs|hooks|bin|public|components|pages)\/[\w./-]+/i;

// The fixed-line patterns, in the order they are tried. Exported so bench/intent-eval.js can score each one.
// Gate: a pattern stays here only with precision at least 0.9 on at least 8 fires in the dev half of the labelled
// eval set. `gold` lists the eval labels that count as a correct fire. `on` says what `test` reads: the request
// kind (advice or not) or the prompt text with pasted blocks removed. None is measured on real prompts yet.
const PRECISE = [
  { id: 'show', name: 'SHOW', gold: ['show'], on: 'kind', test: (text, advice) => advice, line: () => SHOW },
  { id: 'vague', name: 'FEATURE', gold: ['vague'], on: 'text', test: (text) => VAGUE.test(text), line: () => VAGUE_LINE },
  { id: 'sweep', name: 'SWEEP', gold: ['sweep'], on: 'text', test: (text) => SWEEP.test(text), line: () => SWEEP_LINE },
  { id: 'degree', name: 'EXACT', gold: ['exact'], on: 'text', test: (text) => DEGREE_PRECISE.test(text), line: () => `${LITERAL}; ${STEP}.` },
  { id: 'narrow-path', name: 'EXACT', gold: ['exact'], on: 'text', test: (text) => NARROW.test(text) && FILEPATH.test(text), line: () => `${LITERAL}.` },
];

function stripPasted(text) {
  return text.replace(/<pasted[^>]*>[\s\S]*?<\/pasted>/gi, ' ');
}

// 'regex' restores the v9 fixed lines: "intent": "regex" in <root>/.claude/buc.json, or `self` in BUC_OFF / "off". Otherwise 'self'.
function intentMode(root) {
  if (store.off('self', root || process.cwd())) return 'regex';
  let conf = null;
  try { conf = JSON.parse(fs.readFileSync(path.join(root || process.cwd(), '.claude', 'buc.json'), 'utf8')); } catch { /* no config */ }
  return conf && conf.intent === 'regex' ? 'regex' : 'self';
}

// The v9 reading: every short edit prompt gets one of the fixed lines.
function regexIntent(text, advice) {
  if (advice) return { name: 'SHOW', line: SHOW, pattern: 'show' };
  if (VAGUE.test(text)) return { name: 'FEATURE', line: VAGUE_LINE, pattern: 'vague' };
  if (SWEEP.test(text)) return { name: 'SWEEP', line: SWEEP_LINE, pattern: 'sweep' };
  if (NARROW.test(text) || DEGREE.test(text) || PATHLIKE.test(text) || SPECIFIC.test(text)) {
    return { name: 'EXACT', line: LITERAL + (DEGREE.test(text) ? '; ' + STEP : '') + '.', pattern: 'literal' };
  }
  return { name: 'FEATURE', line: E2E + (text.split(/\s+/).length <= 25 ? ASSUME : ''), pattern: 'e2e' };
}

// Replaces the intent line on edit prompts while handsoff.active(repo); the Stop hook enforces it (handsoff-no-edits).
const HANDSOFF_LINE = "In this repo the user usually wants the steps, not edits. Do not edit: list exact files, lines and commands, then end with: Say 'apply' and I will make these edits.";

// Words that put the change on a screen. "header" also means an HTTP header, so it needs a prompt without network words.
const UI = /\b(ui|screens?|pages?|buttons?|icons?|modals?|dialogs?|menus?|footer|sidebar|nav ?bar|toolbar|tooltips?|layout|css|styl(e|es|ing)|colou?rs?|fonts?|padding|margins?|spacing|cards?|banners?|themes?|dark mode|animations?|logo|badges?|dropdowns?|checkbox(es)?|gr[ae]y(ed)?( out)?|landing|responsive|symbols?)\b/i;
const HEADER = /\bheaders?\b/i;
const NETWORK = /\b(https?|requests?|responses?|auth\w*|cors|api|content-type|fetch|curl)\b/i;

// True when the prompt is about something the user looks at.
function isUiPrompt(prompt) {
  const text = stripPasted(String(prompt || ''));
  return UI.test(text) || (HEADER.test(text) && !NETWORK.test(text));
}

// True when a dev server for a screenshot can be found without starting anything: ui.dev or ui.url in
// .claude/buc.json, a Playwright config, or a local vite. "ui": false, or `shot` in BUC_OFF / "off", turns it off.
function uiServer(root) {
  if (!root || store.off('shot', root)) return false;
  let conf = null;
  try { conf = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'buc.json'), 'utf8')); } catch { /* no config */ }
  if (conf && conf.ui === false) return false;
  const ui = conf && conf.ui && typeof conf.ui === 'object' ? conf.ui : {};
  if ([ui.dev, ui.url].some((v) => typeof v === 'string' && v.trim())) return true;
  if (['ts', 'js', 'mjs', 'cjs'].some((ext) => fs.existsSync(path.join(root, `playwright.config.${ext}`)))) return true;
  return fs.existsSync(path.join(root, 'node_modules', '.bin', 'vite'));
}

// The screenshot instruction, or '' when the helper is not installed under pluginRoot.
function shotLine(pluginRoot) {
  const bin = path.join(String(pluginRoot || ''), 'bin', 'buc-shot');
  if (!pluginRoot || !fs.existsSync(bin)) return '';
  return `After editing, run node "${bin}" --path <route>, Read the PNG once and say what you saw.`;
}

const NONE = { name: '', line: '', pattern: '' };

// {name, line, pattern}: the turn-file intent name, the line to inject and the id of the pattern that chose it.
// name is 'EXACT' | 'FEATURE' | 'SWEEP' | 'SHOW' | 'SELF' | ''. mode is 'self' (default) or 'regex'.
function readIntent(prompt, { kind, mode = 'self' } = {}) {
  const text = stripPasted(String(prompt || '')).trim();
  if (!text) return NONE;
  if (text.split(/\s+/).length > MAX_WORDS) return NONE;
  if (CRITERIA.test(text)) return NONE;
  const review = kind === 'review' || (kind === undefined && classify(text).route === 'review');
  // v9 did not count the hook's 'advice' kind; regex mode keeps that so it stays a faithful ablation arm.
  if (mode === 'regex') return regexIntent(text, review);
  const advice = review || kind === 'advice';
  const hit = PRECISE.find((p) => p.test(text, advice));
  if (hit) return { name: hit.name, line: hit.line(text), pattern: hit.id };
  if (isApply(text)) return NONE;
  return { name: 'SELF', line: SELF, pattern: 'self' };
}

const intentLine = (prompt, opts) => readIntent(prompt, opts).line;

const STILL = /^\s*still\b|\b(doesn'?t|didn'?t|does not|did not|isn'?t|not) work|\bstill (broken|wrong|not|fails?)\b|\bno longer works?\b/i;
const UNDO_SHOW = /\b(undo|revert)\b[\s\S]*\b(show|tell|explain)\b|\bjust (show|tell)\b/i;
const STILL_LINE = 'Your last change is still wrong from the user\'s view. Re-read their original words, run or trace the exact screen they mean, keep what was right and fix what they still see. Say in one line what was wrong.';
const UNDO_LINE = 'This corrects your last turn: restore only the files you changed (git checkout -- <file>, or delete files you created), then answer in text only with exact steps.';
const MISREAD_LINE = 'This corrects your last turn. Do not defend it or ask: take the most likely different reading of the original request, redo it that way, undo only what conflicts, and open with one line naming the new reading. If no other reading fits the user\'s words, change nothing: show the exact before and after of what you did (file and line, or a screenshot) and stop.';

// Short degree feedback on the last change: "not that plain", "way too big", "tone it down".
const OVERSHOOT = /^\s*(no[, ]+)?(not (that|so|as|quite (that|so)) (?!one\b|file\b|page\b|screen\b|button\b|part\b|thing\b)\w+|((that'?s|it'?s|now it'?s|now) )?((wa+y+|far|much|a bit|a little|still) )?too (?!many requests)\w+|tone it down|dial it back)\b/i;
const OVERSHOOT_WORDS = 12;
const OVERSHOOT_LINE = 'You overshot. Keep the direction of your last change and move about halfway back toward how it was before; do not revert it fully, start over or change anything else.';

// Follow-up turns: replaces the intent line when the prompt corrects the previous turn.
// {name, line, pattern}; name is 'UNDO' | 'MISREAD' | '' (still-wrong and overshoot have no turn-file name).
function readCorrection(prompt, hadPrev) {
  const text = stripPasted(String(prompt || '')).trim();
  if (!hadPrev || !text) return NONE;
  if (STILL.test(text)) return { name: '', line: STILL_LINE, pattern: 'still' };
  if (OVERSHOOT.test(text) && text.split(/\s+/).length <= OVERSHOOT_WORDS) return { name: '', line: OVERSHOOT_LINE, pattern: 'overshoot' };
  if (!isCorrection(text)) return NONE;
  return UNDO_SHOW.test(text) ? { name: 'UNDO', line: UNDO_LINE, pattern: 'undo-show' } : { name: 'MISREAD', line: MISREAD_LINE, pattern: 'misread' };
}

const correctionLine = (prompt, hadPrev) => readCorrection(prompt, hadPrev).line;

module.exports = { intentLine, correctionLine, readIntent, readCorrection, intentMode, PRECISE, SELF, SELF_SHORT, HANDSOFF_LINE, isUiPrompt, uiServer, shotLine, stripPasted };
