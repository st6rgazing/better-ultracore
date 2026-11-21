'use strict';
// Prompt-time lines about orchestration, for hooks/inject.js. Each line is fixed text (the prompt cache keeps working)
// and under 80 chars, so it fits beside the self-classification line inside the 500-char cap for fixed lines.
// Source: reports that the ultracode keyword fires when it is only talked about, and that it drops proportionality.
const store = require('./rules/store');

const WORD = /ultracode/gi;
const QUOTED = /```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]*'(?!\w)/g;
// Words that make the keyword the thing talked about, not the thing asked for.
const BEFORE = /\b(the|a|an|this|that|about|of|is|does|did|how|why|what|what's|without|no|not|never|don'?t use|do not use|disable|avoid|skip|like|than|vs|versus|called|named|word|keyword|term|in|with|for|on|from)\s+$/i;
const AFTER = /^\s+(mode|keyword|feature|plugin|command|docs?|issues?|bugs?|complaints?|triggers?|is|was|does|did|means|costs?|uses?|burn\w*|runs?|launch\w*|workflows?|agents?)\b|^\s*\?/i;

// How a prompt uses the keyword: 'optin' (a bare word asking for it), 'mention' (every use is quoted, in code,
// part of a name or path, or the subject of the sentence) or 'none'.
function keywordUse(prompt) {
  const text = String(prompt || '');
  if (!/ultracode/i.test(text)) return 'none';
  const bare = text.replace(QUOTED, ' ');
  let optin = false;
  for (const m of bare.matchAll(WORD)) {
    const before = bare.slice(0, m.index);
    const after = bare.slice(m.index + m[0].length);
    const named = /[\w./_-]$/.test(before) || /^[\w/_-]|^\.\w|^'s\b/.test(after);
    if (!named && !BEFORE.test(before) && !AFTER.test(after)) optin = true;
  }
  return optin ? 'optin' : 'mention';
}

const SMALL_WORDS = 25;
const LIST = /^\s*(\d+[.)]|[-*])\s/m;
const MANY = /\b(all|every|each|whole|entire|across|migrat\w*|refactor\w*|rewrite|audit|review)\b/i;

// True when a prompt asks for one small thing: at most 25 words beside the keyword, no list of parts and no word of breadth.
function isSmall(prompt) {
  const text = String(prompt || '').replace(/<pasted[^>]*>[\s\S]*?<\/pasted>/gi, ' ').replace(WORD, ' ').trim();
  return Boolean(text) && text.split(/\s+/).length <= SMALL_WORDS && !LIST.test(text) && !MANY.test(text);
}

const SOLO = 'This is a small task: do it solo in this session, no agents or workflow.';
const SIZED = 'Size the fan-out to the task: few agents, a model set on each, no repeats.';
const NOT_OPTIN = 'The word ultracode is only mentioned here: it is not a request for a workflow.';
const MIDTURN = 'If agents are still running: this message is for you only; do not relay it.';
const RUNNING_MS = 30 * 60000;

// True when the turn file left by the tool hook shows agents launched in the last 30 minutes and no Stop since
// (the Stop hook clears the file): a prompt that arrives now lands in the middle of that work.
function midTurn(turn, now = store.now()) {
  return Boolean(turn) && Number(turn.agents) > 0 && Number(turn.agentAt) > 0 && now - Number(turn.agentAt) < RUNNING_MS;
}

// The orchestration line for a prompt, '' when none applies. `turn` is the turn file as it was before this prompt.
// BUC_OFF names: midturn (agents in flight), keyword (the keyword as a mention), solo (an opt-in: solo when small, sized otherwise).
function line(prompt, { turn = null, root = process.cwd() } = {}) {
  const on = (name) => !store.off(name, root);
  if (on('midturn') && midTurn(turn)) return MIDTURN;
  const use = keywordUse(prompt);
  if (use === 'mention') return on('keyword') ? NOT_OPTIN : '';
  if (use === 'optin' && on('solo')) return isSmall(prompt) ? SOLO : SIZED;
  return '';
}

module.exports = { keywordUse, isSmall, midTurn, line, SOLO, SIZED, NOT_OPTIN, MIDTURN };
