'use strict';
// Accepts `add --priority <p> <text>` or `add <text> --priority <p>`; high must list before low.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const run = (...a) => execFileSync('node', ['todo.js', ...a], { cwd: dir, encoding: 'utf8' });
const tryAdd = (p, text) => {
  try { run('add', '--priority', p, text); return; } catch { /* other form */ }
  run('add', text, '--priority', p);
};
fs.rmSync(path.join(dir, 'todos.json'), { force: true });
tryAdd('low', 'lowtask');
tryAdd('high', 'hightask');
run('add', 'plaintask');
const out = run('list');
if (!(out.indexOf('hightask') >= 0 && out.indexOf('hightask') < out.indexOf('lowtask'))) process.exit(1);
if (!out.includes('plaintask')) process.exit(1);
if (/--priority/.test(out)) process.exit(1);
fs.rmSync(path.join(dir, 'todos.json'), { force: true });
