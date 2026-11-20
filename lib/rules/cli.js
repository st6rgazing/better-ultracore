'use strict';
const fs = require('node:fs');
const store = require('./store');

const fmt = (r) => `${r.id}\tscore=${store.score(r).toFixed(1)}\tcount=${r.count}\tviolations=${r.violations}${r.pinned ? '\tpinned' : ''}\t${r.rule}`;

// buc rules list|why <id>|pin <id>|drop <id>|import <file.json>
function run([sub, arg]) {
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
    store.saveRules(rules.map((r) => (r.id === arg ? { ...r, pinned: !r.pinned } : r)));
  } else if (sub === 'drop') {
    find();
    store.saveRules(rules.filter((r) => r.id !== arg));
  } else if (sub === 'import') {
    if (!arg) throw new Error('rules import needs <file.json>');
    const { added, rejected } = store.importRules(JSON.parse(fs.readFileSync(arg, 'utf8')));
    console.log(JSON.stringify({ added, rejected }));
    return rejected.length ? 1 : 0;
  } else {
    throw new Error('usage: buc rules list|why <id>|pin <id>|drop <id>|import <file.json>');
  }
  return 0;
}

module.exports = { run };
