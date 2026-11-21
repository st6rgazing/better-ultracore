'use strict';
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

const fmt = (r) => `${r.id}\tscore=${store.score(r).toFixed(1)}\tcount=${r.count}\tviolations=${r.violations}${r.pinned ? '\tpinned' : ''}${r.scope && r.scope.repos ? `\tonly=${r.scope.repos.join(',')}` : ''}\t${r.rule}`;

const BOOLEAN = new Set(['global']);

function parse(argv) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) args.push(argv[i]);
    else if (BOOLEAN.has(argv[i].slice(2))) flags[argv[i].slice(2)] = true;
    else flags[argv[i].slice(2)] = argv[++i];
  }
  return { flags, args };
}

// buc rules as-of --before <iso> --exclude-sessions a,b --out <dir>
// Writes <dir>/rules.json: the rules (live and archived) as they stood before the date, without what the listed sessions taught.
// Point BUC_HOME at <dir> to run against it. The live store is only read.
function asOf(flags) {
  if (!flags.out) throw new Error('rules as-of needs --out <dir>');
  const out = path.resolve(flags.out);
  if (out === path.resolve(store.home())) throw new Error('rules as-of: --out must not be the live store');
  let archived = [];
  try { archived = JSON.parse(fs.readFileSync(path.join(store.home(), 'rules.archive.json'), 'utf8')); } catch { /* no archive */ }
  const live = store.loadRules();
  const ids = new Set(live.map((r) => r.id));
  const all = [...live, ...(Array.isArray(archived) ? archived : []).filter((r) => r && !ids.has(r.id) && ids.add(r.id))];
  const excludeSessions = String(flags['exclude-sessions'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const kept = store.asOf(all, { before: flags.before, excludeSessions });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'rules.json'), `${JSON.stringify(kept, null, 2)}\n`);
  const keptIds = new Set(kept.map((r) => r.id));
  console.log(JSON.stringify({ before: flags.before || null, excluded: excludeSessions, kept: kept.map((r) => r.id), dropped: all.map((r) => r.id).filter((id) => !keptIds.has(id)), out: path.join(out, 'rules.json') }));
  return 0;
}

// buc rules list|why <id>|pin [--global] <id>|drop <id>|import <file.json>|as-of ...
function run([sub, ...rest]) {
  const { flags, args: [arg] } = parse(rest);
  if (sub === 'as-of') return asOf(flags);
  const rules = store.sweep();
  const find = () => {
    const r = rules.find((x) => x.id === arg);
    if (!r) throw new Error(`no rule ${arg}`);
    return r;
  };
  if (sub === 'list') {
    for (const r of rules) console.log(fmt(r));
  } else if (sub === 'why') {
    const r = find();
    console.log(JSON.stringify({ ...r, score: store.score(r) }, null, 2));
  } else if (sub === 'pin') {
    find();
    // --global: pin the rule and drop its repo scope, so it applies in every repo. Plain pin toggles and keeps the scope.
    const global = ({ scope: _scope, ...r }) => ({ ...r, pinned: true });
    store.saveRules(rules.map((r) => (r.id !== arg ? r : flags.global ? global(r) : { ...r, pinned: !r.pinned })));
  } else if (sub === 'drop') {
    find();
    store.saveRules(rules.filter((r) => r.id !== arg));
  } else if (sub === 'import') {
    if (!arg) throw new Error('rules import needs <file.json>');
    const { added, rejected } = store.importRules(JSON.parse(fs.readFileSync(arg, 'utf8')));
    console.log(JSON.stringify({ added, rejected }));
    return rejected.length ? 1 : 0;
  } else {
    throw new Error('usage: buc rules list|why <id>|pin [--global] <id>|drop <id>|import <file.json>|as-of --before <iso> --exclude-sessions a,b --out <dir>');
  }
  return 0;
}

module.exports = { run };
