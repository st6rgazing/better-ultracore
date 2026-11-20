'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runChecks } = require('../lib/rules/check');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-chk-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'app.js'), 'const label = "old text";\n');
  fs.writeFileSync(path.join(dir, 'other.js'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

// Baseline snapshot as the inject hook records it.
const turn = (dir, prompt, kind = 'edit') => ({
  cwd: dir, prompt, kind, head: git(dir, 'rev-parse', 'HEAD'), porcelain: execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }),
});
const run = (id, t) => runChecks([id], t)[0];
const write = (dir, f, s) => fs.writeFileSync(path.join(dir, f), s);

test('advice-no-edits', () => {
  const dir = repo();
  const t = turn(dir, 'tell me how this works', 'advice');
  assert.strictEqual(run('advice-no-edits', t).pass, true);
  write(dir, 'app.js', 'changed\n');
  const r = run('advice-no-edits', t);
  assert.strictEqual(r.pass, false);
  assert.match(r.detail, /app\.js/);
  assert.strictEqual(run('advice-no-edits', { ...t, kind: 'edit' }).pass, true);
});

test('only-named-files allows named files, tests and lockfiles', () => {
  const dir = repo();
  const t = turn(dir, 'change the label in app.js only');
  write(dir, 'app.js', 'a\n');
  fs.mkdirSync(path.join(dir, 'test'));
  write(dir, 'test/app.test.js', 't\n');
  write(dir, 'package-lock.json', '{}\n');
  assert.strictEqual(run('only-named-files', t).pass, true);
  write(dir, 'other.js', 'y\n');
  const r = run('only-named-files', t);
  assert.strictEqual(r.pass, false);
  assert.match(r.detail, /other\.js/);
});

test('only-named-files ignores non-file tokens and prompts without an only cue', () => {
  const dir = repo();
  write(dir, 'other.js', 'y\n');
  assert.strictEqual(run('only-named-files', turn(dir, 'update app.js')).pass, true);
  git(dir, 'checkout', '-q', 'other.js');
  const t = turn(dir, 'only bump version 1.2 and e.g. fix it');
  write(dir, 'other.js', 'z\n');
  assert.strictEqual(run('only-named-files', t).pass, true);
  git(dir, 'checkout', '-q', 'other.js');
  const u = turn(dir, 'just change app.js, nothing else');
  write(dir, 'app.js', 'a\n');
  write(dir, 'other.js', 'q\n');
  assert.match(run('only-named-files', u).detail, /other\.js/);
});

test('no-ai-traces checks added lines and new commit messages, not pre-existing dirt', () => {
  const dir = repo();
  write(dir, 'other.js', '// Generated with a tool\n');
  const t = turn(dir, 'edit app.js');
  assert.strictEqual(run('no-ai-traces', t).pass, true);
  write(dir, 'app.js', 'a\n// see CLAUDE.md, .claude/ and CLAUDE_PLUGIN_ROOT\n');
  assert.strictEqual(run('no-ai-traces', t).pass, true);
  write(dir, 'app.js', 'a\n// Generated with [Claude Code]\n');
  const r = run('no-ai-traces', t);
  assert.strictEqual(r.pass, false);
  assert.match(r.detail, /app\.js:2/);
  assert.ok(!r.detail.includes('Generated'));
  write(dir, 'app.js', 'a\n// Co-Authored-By: Claude <x@y>\n');
  assert.strictEqual(run('no-ai-traces', t).pass, false);
  git(dir, 'checkout', 'app.js');
  git(dir, 'commit', '-qam', 'fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  assert.match(run('no-ai-traces', t).detail, /commit message/);
});

test('no-emoji', () => {
  const dir = repo();
  const t = turn(dir, 'add a label');
  write(dir, 'app.js', 'const a = 1;\n');
  assert.strictEqual(run('no-emoji', t).pass, true);
  write(dir, 'app.js', 'const a = 1;\nconst b = "\u{1F680} go";\n');
  assert.match(run('no-emoji', t).detail, /app\.js:2/);
  write(dir, 'new.js', '\u{2705}\n');
  assert.strictEqual(run('no-emoji', t).pass, false);
});

test('exact-copy needs the new string present and the old one gone', () => {
  const dir = repo();
  const t = turn(dir, 'change \'old text\' to "new text"');
  write(dir, 'app.js', 'const label = "old text new text";\n');
  assert.match(run('exact-copy', t).detail, /old string still present/);
  write(dir, 'app.js', 'const label = "other";\n');
  assert.match(run('exact-copy', t).detail, /new string not found/);
  write(dir, 'app.js', 'const label = "new text";\n');
  assert.strictEqual(run('exact-copy', t).pass, true);
});

test('exact-copy reads old and new from a quoted pair', () => {
  const dir = repo();
  write(dir, 'app.js', 'const label = "Sign in";\n');
  git(dir, 'commit', '-qam', 'label');
  for (const p of ['change "Sign in" to "Log in"', 'change `Sign in` with `Log in`', "change 'Sign in' → 'Log in'"]) {
    git(dir, 'checkout', '-q', 'app.js');
    const t = turn(dir, p);
    write(dir, 'app.js', 'const label = "Log in";\n');
    assert.strictEqual(run('exact-copy', t).pass, true, p);
    write(dir, 'app.js', 'const label = "Sign in Log in";\n');
    assert.match(run('exact-copy', t).detail, /old string still present/);
  }
  git(dir, 'checkout', '-q', 'app.js');
  const t = turn(dir, 'say "hello there" in the header');
  write(dir, 'app.js', 'const label = "hello there";\n');
  assert.strictEqual(run('exact-copy', t).pass, true);
});

test('check-cmd runs only the command configured by the user', () => {
  const dir = repo();
  const t = turn(dir, 'make `node ok.js` pass');
  assert.strictEqual(run('check-cmd', t).pass, true);
  fs.mkdirSync(path.join(dir, '.claude'));
  write(dir, '.claude/buc.json', JSON.stringify({ checkCmd: 'node ok.js' }));
  write(dir, 'ok.js', 'process.exit(0)\n');
  assert.strictEqual(run('check-cmd', t).pass, true);
  write(dir, 'ok.js', 'process.exit(3)\n');
  const r = run('check-cmd', t);
  assert.strictEqual(r.pass, false);
  assert.match(r.detail, /exit 3/);
});

test('check-cmd passes when nothing changed or the command cannot run', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, '.claude'));
  write(dir, '.claude/buc.json', JSON.stringify({ checkCmd: 'node fail.js' }));
  write(dir, 'fail.js', 'process.exit(1)\n');
  const t = turn(dir, 'edit app');
  const idle = run('check-cmd', t);
  assert.strictEqual(idle.pass, true);
  assert.match(idle.detail, /no files changed/);
  write(dir, 'app.js', 'changed\n');
  assert.strictEqual(run('check-cmd', t).pass, false);
  write(dir, '.claude/buc.json', JSON.stringify({ checkCmd: 'definitely-not-a-command-xyz' }));
  const gone = run('check-cmd', t);
  assert.strictEqual(gone.pass, true);
  assert.strictEqual(gone.detail, 'skipped');
});

test('check-cmd never executes commands found in prompt text', () => {
  const dir = repo();
  write(dir, 'dist', 'keep\n');
  for (const p of ['Rename `rm -rf dist` step', 'then run rm -rf dist; npm test should pass', 'make `touch pwned` pass']) {
    assert.strictEqual(run('check-cmd', turn(dir, p)).pass, true);
  }
  assert.ok(fs.existsSync(path.join(dir, 'dist')));
  assert.ok(!fs.existsSync(path.join(dir, 'pwned')));
});

test('small-commits needs one commit per item and a clean tree', () => {
  const dir = repo();
  const t = turn(dir, 'do these and commit after each:\n1. edit app\n2. edit other');
  write(dir, 'app.js', 'a\n');
  git(dir, 'commit', '-qam', 'one');
  assert.match(run('small-commits', t).detail, /1 commits for 2 items/);
  write(dir, 'other.js', 'b\n');
  assert.match(run('small-commits', t).detail, /tree not clean/);
  git(dir, 'commit', '-qam', 'two');
  assert.strictEqual(run('small-commits', t).pass, true);
  assert.strictEqual(run('small-commits', turn(dir, 'just edit')).pass, true);
});

test('typecheckCmd reads package scripts or buc.json, and autoCheck false turns it off', () => {
  const { typecheckCmd } = require('../lib/rules/check');
  const dir = repo();
  assert.strictEqual(typecheckCmd(dir), '');
  write(dir, 'package.json', JSON.stringify({ scripts: { 'type-check': 'tsc' } }));
  assert.strictEqual(typecheckCmd(dir), 'npm run -s type-check');
  fs.mkdirSync(path.join(dir, '.claude'));
  write(dir, '.claude/buc.json', JSON.stringify({ typecheckCmd: 'node tc.js' }));
  assert.strictEqual(typecheckCmd(dir), 'node tc.js');
  write(dir, '.claude/buc.json', JSON.stringify({ autoCheck: false }));
  assert.strictEqual(typecheckCmd(dir), '');
});

test('typecheck blocks with output after a change, skips when idle, missing deps or timed out', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, '.claude'));
  write(dir, '.claude/buc.json', JSON.stringify({ typecheckCmd: 'node tc.js' }));
  write(dir, 'tc.js', 'console.log("app.ts(1,1): error TS2304"); process.exit(2)\n');
  const t = turn(dir, 'edit app');
  assert.strictEqual(run('typecheck', t).pass, true);
  write(dir, 'app.js', 'changed\n');
  const r = run('typecheck', t);
  assert.strictEqual(r.pass, false);
  assert.match(r.detail, /TS2304/);
  assert.match(r.detail, /before your change/);
  write(dir, 'package.json', '{}');
  assert.strictEqual(run('typecheck', t).detail, 'skipped: no node_modules');
});
