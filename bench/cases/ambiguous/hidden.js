// Hidden acceptance check; copied into the fixture only at accept time.
// Usage: node hidden.js <repo dir>. Exit 0 iff a done feature (CLI `done <index>` or export done(i)) works.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const src = path.resolve(process.argv[2]);
const run = (cwd, args) => { try { return execFileSync('node', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };

function attempt(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-'));
  fs.cpSync(src, dir, { recursive: true, filter: (p) => !p.includes(`${path.sep}.git${path.sep}`) && path.basename(p) !== 'todos.json' });
  try {
    run(dir, ['todo.js', 'add', 'alpha']);
    run(dir, ['todo.js', 'add', 'beta']);
    const line = (out, w) => out.split('\n').find((l) => l.includes(w)) || '';
    const before = run(dir, ['todo.js', 'list']);
    const idx = (line(before, 'beta').match(/\d+/) || [])[0]; // index as displayed to the user
    if (idx === undefined || /\[x\]/i.test(before)) return false;
    if (mode === 'cli') run(dir, ['todo.js', 'done', idx]);
    else run(dir, ['-e', `Promise.resolve(require('./todo').done(${idx}))`]);
    const after = run(dir, ['todo.js', 'list']);
    return /\[x\]/i.test(line(after, 'beta')) && !/\[x\]/i.test(line(after, 'alpha'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

process.exit(attempt('cli') || attempt('export') ? 0 : 1);
