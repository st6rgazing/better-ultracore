'use strict';

const { execFileSync } = require('child_process');
const store = require('./store');
const { matchedKeywords } = require('./retrieve');

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

function find(id, root) {
  const rec = store.loadAll(root).find((r) => r.id === id);
  if (!rec) console.error(`no such preference: ${id}`);
  return rec;
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

  scope({ args }, root) {
    const rec = find(args[0], root);
    if (!rec) return 1;
    const next = args[1] === 'project' ? `project:${root}` : args[1];
    store.validate({ ...rec, scope: next });
    store.remove(rec.id, rec.scope === 'global' ? null : root);
    store.save({ ...rec, scope: next }, root);
    console.log(`${rec.id} scope -> ${next}`);
    return 0;
  },

  why({ args, flags }, root) {
    const rec = find(args[0], root);
    if (!rec) return 1;
    const { session_id: sid, file, line: ln } = rec.source;
    console.log(line(rec));
    console.log(`source: session ${sid}, ${file}:${ln}`);
    console.log(`sessions: ${rec.sessions.join(', ')}`);
    console.log(`trigger: keywords [${rec.trigger.keywords.join(', ')}], paths [${rec.trigger.paths.join(', ')}]`);
    if (rec.check) console.log(`check: ${rec.check}`);
    if (typeof flags.request === 'string') {
      console.log(`matched for request: [${matchedKeywords(rec, flags.request).join(', ')}]`);
    }
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
