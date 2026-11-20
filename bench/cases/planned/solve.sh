#!/bin/sh
cd "$1" || exit 1
node - <<'JS'
const fs = require('fs');
let s = fs.readFileSync('todo.js', 'utf8');
s = s.replace("function add(text) {\n  const todos = load();\n  todos.push({ text });",
  "const RANK = { high: 0, normal: 1, low: 2 };\nfunction add(text, priority = 'normal') {\n  const todos = load();\n  todos.push({ text, priority });");
s = s.replace("return load().map(", "return load().map((t, i) => ({ ...t, i })).sort((a, b) => (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1) || a.i - b.i).map(");
s = s.replace("if (cmd === 'add') add(rest.join(' '));",
  "if (cmd === 'add') { const k = rest.indexOf('--priority'); const p = k >= 0 ? rest.splice(k, 2)[1] : 'normal'; add(rest.join(' '), p); }");
fs.writeFileSync('todo.js', s);
fs.writeFileSync('README.md', '# todo\n\n`node todo.js add [--priority high|normal|low] <text>`\n');
JS
