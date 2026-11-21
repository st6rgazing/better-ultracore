'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const store = require('./store');

const ID = 'neighbour-states';
const MAX = 8;
// UI or game-flow files: component extensions, or game, screen, menu or state in the path.
const FLOW = /\.(tsx|jsx|vue|svelte)$|game|screen|menu|state/i;
const CODE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Module name as importers write it: the file stem, or the folder for an index file.
function stem(file) {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  return base === 'index' ? path.basename(path.dirname(file)) : base;
}

// Other files that import any of the changed modules, at most MAX.
function importers(cwd, changed) {
  const names = [...new Set(changed.map(stem).filter((s) => s && s !== '.'))];
  if (!names.length) return [];
  const pattern = `(import|require|from).*[/'"](${names.map(esc).join('|')})(\\.[a-z]+)?['"]`;
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-lE', '--untracked', '-e', pattern], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { /* exit 1: no hits */ }
  return out.split('\n').filter((f) => f && CODE.test(f) && !changed.includes(f)).slice(0, MAX);
}

// Soft. The turn changed UI or game-flow files that other files import, and the reply does not name those files.
function check({ turn, cwd, input }) {
  const pass = { id: ID, pass: true, detail: '' };
  if (store.off('neighbours', cwd)) return pass;
  const changed = require('./check').changedFiles(cwd, turn).filter((f) => FLOW.test(f));
  if (!changed.length) return pass;
  const reply = String((input && input.last_assistant_message) || '').toLowerCase();
  const unchecked = importers(cwd, changed).filter((f) => !reply.includes(stem(f).toLowerCase()));
  if (!unchecked.length) return pass;
  return { id: ID, pass: false, detail: `Other entry points use what you changed: ${unchecked.join(', ')}. Check each one (new vs continued state, every menu) and say what you verified.` };
}

module.exports = { ID, check, importers };
