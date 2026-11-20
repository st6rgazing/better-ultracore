'use strict';

const { execFileSync } = require('child_process');
const store = require('./store');

const VALUE_FLAGS = new Set(['--scope', '--request', '--files']);

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) pos.push(a);
    else if (VALUE_FLAGS.has(a)) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
  return { pos, flags };
}

function repoRootOf(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return cwd;
  }
}

function line(rec) {
  return `[${rec.id}] (${rec.status}, ${rec.scope}, ${rec.kind}) ${rec.correction}`;
}

const COMMANDS = {
  list({ flags }, root) {
    const all = store.loadAll(root);
    const shown = all.filter((r) => flags.all || r.status !== 'suggested');
    shown.forEach((r) => console.log(line(r)));
    const hidden = all.length - shown.length;
    if (hidden) console.log(`${hidden} suggested hidden (use --all)`);
    return 0;
  },
};

function run(argv) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  const root = repoRootOf();
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`usage: buc prefs <${Object.keys(COMMANDS).join('|')}> ...`);
    return 2;
  }
  return fn({ args: rest, flags }, root);
}

module.exports = { run, parseArgs };
