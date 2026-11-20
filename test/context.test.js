'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ctx = require('../lib/context');

const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-ctx-'));
  const bare = path.join(dir, 'bare.git');
  sh(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  sh(dir, 'clone', '-q', bare, a);
  fs.writeFileSync(path.join(a, 'router.js'), '1');
  fs.writeFileSync(path.join(a, 'notes.md'), 'n');
  sh(a, 'add', '.');
  sh(a, 'commit', '-qm', 'init');
  sh(a, 'push', '-q', 'origin', 'main');
  sh(dir, 'clone', '-q', bare, b);
  return { dir, bare, a, b };
}

test('repoInfo reports root, head, branch, upstream', () => {
  const f = fixture();
  const info = ctx.repoInfo(f.a);
  assert.strictEqual(fs.realpathSync(info.root), fs.realpathSync(f.a));
  assert.strictEqual(info.head, sh(f.a, 'rev-parse', 'HEAD'));
  assert.strictEqual(info.branch, 'main');
  assert.strictEqual(info.upstream, 'origin/main');
});

test('refStatus: fresh clone is not stale', () => {
  const f = fixture();
  const r = ctx.refStatus(f.a, 'main');
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.local_sha, r.remote_sha);
});

test('refStatus: remote advanced elsewhere is stale', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.b, 'new.js'), '2');
  sh(f.b, 'add', '.');
  sh(f.b, 'commit', '-qm', 'advance');
  sh(f.b, 'push', '-q', 'origin', 'main');
  const r = ctx.refStatus(f.a, 'main');
  assert.strictEqual(r.stale, true);
  assert.notStrictEqual(r.local_sha, r.remote_sha);
});

test('refStatus: offline skips the network and is never stale', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.b, 'new.js'), '2');
  sh(f.b, 'add', '.');
  sh(f.b, 'commit', '-qm', 'advance');
  sh(f.b, 'push', '-q', 'origin', 'main');
  const r = ctx.refStatus(f.a, 'main', { offline: true });
  assert.deepStrictEqual([r.remote_sha, r.stale], [null, false]);
});

test('mentionedRef finds an existing branch only', () => {
  const f = fixture();
  assert.strictEqual(ctx.mentionedRef(f.a, 'please look at main and fix it'), 'main');
  assert.strictEqual(ctx.mentionedRef(f.a, 'do it on the server'), null);
});

test('relevantFiles ranks by path words and caps the list', () => {
  const f = fixture();
  assert.deepStrictEqual(ctx.relevantFiles(f.a, 'fix the router bug'), ['router.js']);
  assert.deepStrictEqual(ctx.relevantFiles(f.a, 'zzz'), []);
});

test('context: stale regression for "look at main", workflow-arg shape', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.b, 'new.js'), '2');
  sh(f.b, 'add', '.');
  sh(f.b, 'commit', '-qm', 'advance');
  sh(f.b, 'push', '-q', 'origin', 'main');
  const c = ctx.context('look at main and fix router.js typo', { cwd: f.a });
  assert.strictEqual(c.ref.ref, 'main');
  assert.strictEqual(c.ref.stale, true);
  assert.strictEqual(c.base, c.head);
  assert.ok(['small', 'planned', 'guarded', 'parallel', 'review'].includes(c.route));
  assert.deepStrictEqual(c.files, ['router.js']);
  assert.ok(Array.isArray(c.prefs));
});

test('context: no ref mention gives ref null', () => {
  const f = fixture();
  assert.strictEqual(ctx.context('fix typo in router.js', { cwd: f.a, offline: true }).ref, null);
});

test('affected: steps touching corrected files or areas', () => {
  const steps = [{ id: 'work:a', files: ['lib/a.js'] }, { id: 'work:b', files: ['ui/b.js'] }, { id: 'verify', files: [] }];
  assert.deepStrictEqual(ctx.affected(steps, ['lib/a.js']), ['work:a']);
  assert.deepStrictEqual(ctx.affected(steps, ['ui']), ['work:b']);
  assert.deepStrictEqual(ctx.affected(steps, ['docs/']), []);
});
