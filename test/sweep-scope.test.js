'use strict';
// A request that names the whole app and ends in a narrow diff gets one soft Stop note.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { sweepPhrase } = require('../lib/intent');
const check = require('../lib/rules/check');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const write = (dir, f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };

// A repo with five source files and a test file, all holding the same old label.
function repo() {
  const dir = tmp('buc-sweep-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  for (const f of ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'test/a.test.js']) write(dir, f, 'const label = "old";\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}
const turn = (dir, prompt, extra = {}) => ({ session_id: 's', cwd: dir, root: dir, prompt, kind: 'edit', head: git(dir, 'rev-parse', 'HEAD'), porcelain: '', rules: [], checks: [], intent: 'SELF', ...extra });
const run = (t, reply = 'Done.') => check.runChecks(['sweep-scope'], t, t.root, { last_assistant_message: reply })[0];
const edit = (dir, files) => files.forEach((f) => write(dir, f, 'const label = "new";\n'));

test('sweepPhrase returns the whole-scope words of a prompt, and nothing for a pasted block or a plain request', () => {
  assert.strictEqual(sweepPhrase('look through the Whole App and tidy the labels'), 'whole app');
  assert.strictEqual(sweepPhrase('rename it everywhere'), 'everywhere');
  assert.strictEqual(sweepPhrase('remove all traces of the old logo'), 'all traces');
  assert.strictEqual(sweepPhrase('fix every page title'), 'every page');
  assert.strictEqual(sweepPhrase('make the save button blue'), '');
  assert.strictEqual(sweepPhrase('<pasted>shown everywhere</pasted>\nmake the save button blue'), '');
  assert.strictEqual(sweepPhrase(undefined), '');
});

test('sweep-scope fails softly when a whole-app request changed one or two files', () => {
  const dir = repo();
  const t = turn(dir, 'look through the whole app and replace the old label');
  edit(dir, ['a.js', 'test/a.test.js']);
  const one = run(t);
  assert.strictEqual(one.pass, false);
  assert.match(one.detail, /^The request said "whole app" and you changed 1 file \(a\.js\)\. Carry the same change into every other place it belongs now/);
  assert.match(one.detail, /say in one line what you searched\. Do not ask\.$/);
  edit(dir, ['b.js']);
  assert.match(run(t).detail, /you changed 2 files \(a\.js, b\.js\)\./);
  assert.ok(check.SOFT.includes('sweep-scope'));
});

test('sweep-scope passes a wide diff, unless the reply hands left-out work back', () => {
  const dir = repo();
  const t = turn(dir, 'replace the old label everywhere');
  edit(dir, ['a.js', 'b.js', 'c.js']);
  assert.strictEqual(run(t, 'Replaced the label in three files and searched the rest.').pass, true);
  for (const reply of ['I left d.js alone. Say if you want it changed too.', 'Two more files use it. Do you want me to update them?', 'Should I also change e.js?', 'I can update the rest if you want.', 'Let me know if you would like the others done.']) {
    const r = run(t, reply);
    assert.strictEqual(r.pass, false, reply);
    assert.match(r.detail, /you changed 3 files \(a\.js, b\.js, \.\.\.\) and offered the rest back\./);
  }
  assert.strictEqual(run(t, `Do you want me to go on?${' Later text.'.repeat(80)}`).pass, true, 'only the end of the reply is read');
});

test('sweep-scope stays out of the way: no scope words, nothing changed, an advice turn or a no-edit reading', () => {
  const dir = repo();
  edit(dir, ['a.js']);
  assert.strictEqual(run(turn(dir, 'replace the old label in a.js')).pass, true);
  assert.strictEqual(run(turn(dir, '<pasted>used everywhere</pasted>\nreplace the old label in a.js')).pass, true);
  assert.strictEqual(run(turn(dir, 'where is the old label used everywhere?', { kind: 'advice' })).pass, true);
  assert.strictEqual(run(turn(dir, 'undo it everywhere and just show me', { intent: 'UNDO' })).pass, true);
  const clean = repo();
  assert.strictEqual(run(turn(clean, 'replace the old label everywhere'), 'Should I start?').pass, true);
});

test('the Stop hook returns sweep-scope as additionalContext, never a block, and BUC_OFF turns it off', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  const stop = (off) => {
    fs.writeFileSync(path.join(home, 'turn-s.json'), JSON.stringify(turn(dir, 'replace the old label everywhere')));
    const r = spawnSync('node', [path.join(__dirname, '..', 'hooks', 'stop-check.js')], { input: JSON.stringify({ session_id: 's', cwd: dir, last_assistant_message: 'Done.' }), encoding: 'utf8', env: { ...process.env, BUC_HOME: home, BUC_OFF: off } });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  edit(dir, ['a.js']);
  const out = stop('');
  assert.strictEqual(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /^The request said "everywhere" and you changed 1 file/);
  assert.strictEqual(stop('sweep-scope'), null);
});
