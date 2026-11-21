'use strict';
// Names a turn introduced: they occur nowhere in the tree at the turn's baseline commit.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { freshNames } = require('../lib/rules/check');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'buc-fresh-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  for (const [f, s] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), s);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('freshNames keeps the names the baseline tree does not have, whatever the working tree holds now', () => {
  const dir = repo({ 'app.css': '.card { color: red; }\n.card-title { margin: 0; }\n', 'view.jsx': '<div className="card start">x</div>\n' });
  const base = { head: git(dir, 'rev-parse', 'HEAD') };
  fs.appendFileSync(path.join(dir, 'app.css'), '.preview { opacity: 0.5; }\n');
  assert.deepStrictEqual(freshNames(dir, base, ['card', 'preview', 'start', 'greyed', 'preview']), ['preview', 'greyed']);
  assert.deepStrictEqual(freshNames(dir, base, ['title']), [], 'a word inside an old hyphenated name reads as old');
  assert.deepStrictEqual(freshNames(dir, base, ['nowhere', 'either']), ['nowhere', 'either']);
  assert.deepStrictEqual(freshNames(dir, base, []), []);
  assert.deepStrictEqual(freshNames(dir, { head: null }, ['preview']), [], 'no baseline commit, nothing is known to be new');
});
