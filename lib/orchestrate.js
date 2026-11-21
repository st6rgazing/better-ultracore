'use strict';
// Prompt-time lines about orchestration, for hooks/inject.js. Each line is fixed text (the prompt cache keeps working)
// and under 80 chars, so it fits beside the self-classification line inside the 500-char cap for fixed lines.
// Source: reports that the ultracode keyword fires when it is only talked about, and that it drops proportionality.

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

module.exports = { keywordUse };
