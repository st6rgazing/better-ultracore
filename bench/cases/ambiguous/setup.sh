#!/bin/sh
set -e
d="$1"; mkdir -p "$d"; cd "$d"
git init -q -b main
cat > todo.js <<'JS'
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, 'todos.json');

function load() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function save(todos) {
  fs.writeFileSync(file, JSON.stringify(todos, null, 2));
}

function add(text) {
  const todos = load();
  todos.push({ text });
  save(todos);
}

function list() {
  return load().map((t, i) => `${i + 1}. ${t.text}`).join('\n');
}

module.exports = { add, list };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'add') add(rest.join(' '));
  else if (cmd === 'list') console.log(list());
  else { console.error('usage: todo.js add <text> | list'); process.exitCode = 1; }
}
JS
cat > test.js <<'JS'
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const todo = require('./todo');

const store = path.join(__dirname, 'todos.json');
fs.rmSync(store, { force: true });
todo.add('alpha');
todo.add('beta');
const out = todo.list();
assert.ok(out.includes('alpha') && out.includes('beta'));
assert.strictEqual(out.split('\n').length, 2);
fs.rmSync(store, { force: true });
console.log('ok');
JS
printf 'todos.json\n' > .gitignore
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
