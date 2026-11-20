#!/bin/sh
cd "$1" && node -e "
const fs=require('fs');let s=fs.readFileSync('todo.js','utf8');
s=s.replace('return load().map((t, i) => \`\${i + 1}. \${t.text}\`)','return load().map((t, i) => \`\${i + 1}. \${t.done ? \'[x]\' : \'[ ]\'} \${t.text}\`)');
s=s.replace('module.exports = { add, list };','function done(n) {\n  const todos = load();\n  todos[n - 1].done = true;\n  save(todos);\n}\n\nmodule.exports = { add, list, done };');
s=s.replace(\"else if (cmd === 'list')\",\"else if (cmd === 'done') done(Number(rest[0]));\n  else if (cmd === 'list')\");
fs.writeFileSync('todo.js',s);"
