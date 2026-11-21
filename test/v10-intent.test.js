'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const intent = require('../lib/intent');

const INJECT = path.join(__dirname, '..', 'hooks', 'inject.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo(files = {}) {
  const dir = tmp('buc-v10-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  for (const [name, body] of Object.entries({ 'app.js': 'a\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

// Runs the prompt hook; returns the injected text ('' when it printed nothing).
function inject(input, home, env = {}) {
  const r = spawnSync('node', [INJECT], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, BUC_OFF: '', CLAUDE_PLUGIN_ROOT: '', BUC_HOME: home, ...env } });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}
const turn = (home, id) => JSON.parse(fs.readFileSync(path.join(home, `turn-${id}.json`), 'utf8'));

test('the misread line has an exit when no other reading fits', () => {
  const line = intent.correctionLine('no thats not what i meant', true);
  assert.match(line, /different reading/);
  assert.match(line, /If no other reading fits the user's words, change nothing: show the exact before and after/);
  assert.ok(line.length <= 400, String(line.length));
});

test('the guide-icons and house-rules prompt shapes get the self-classification line', () => {
  const shapes = [
    'change the help symbol to be a ! and change the history symbol to the current help one',
    'make it so anyone who is not an admin sees every option but cannot edit it, greyed out',
    'rename x in src/a.js',
    'just one button',
    'add a back button to the settings page',
  ];
  for (const p of shapes) {
    const r = intent.readIntent(p);
    assert.strictEqual(r.line, intent.SELF, p);
    assert.strictEqual(r.name, 'SELF', p);
    assert.strictEqual(r.pattern, 'self', p);
  }
});

test('the self line names the four readings and fits its cap', () => {
  for (const line of [intent.SELF, intent.SELF_SHORT]) {
    for (const word of ['EXACT', 'FEATURE', 'SWEEP', 'SHOW']) assert.match(line, new RegExp(`\\b${word} \\(`));
    assert.match(line, /first line/);
    assert.match(line, /[Dd]o not ask\.$/);
  }
  assert.ok(intent.SELF.length <= 420, String(intent.SELF.length));
  assert.ok(intent.SELF_SHORT.length <= 250, String(intent.SELF_SHORT.length));
});

test('precise patterns keep their fixed line', () => {
  const cases = [
    ['make the card slightly smaller', 'degree', 'EXACT', /small step only/],
    ['move the logo up a bit', 'degree', 'EXACT', /Read the request literally/],
    ['only change the title in src/header.js', 'narrow-path', 'EXACT', /touch only what is named\.$/],
    ['rename Foo everywhere', 'sweep', 'SWEEP', /every occurrence/],
    ['explain how the router works', 'show', 'SHOW', /do not edit files/],
    ['fix the settings page', 'vague', 'FEATURE', /names no defect/],
  ];
  for (const [p, pattern, name, re] of cases) {
    const r = intent.readIntent(p);
    assert.strictEqual(r.pattern, pattern, p);
    assert.strictEqual(r.name, name, p);
    assert.match(r.line, re, p);
  }
  assert.strictEqual(intent.readIntent('tell me how to simplify this, dont change anything', { kind: 'advice' }).name, 'SHOW');
});

test('loose degree and narrowing words no longer choose a line', () => {
  const loose = ['add more tests', 'add a little icon to the header', 'add a bit of padding', 'show less text in the form', 'fix only 1 and 2', 'can you just add a footer', 'use and/or in the label'];
  for (const p of loose) assert.strictEqual(intent.readIntent(p).pattern, 'self', p);
});

test('silent on criteria, long prompts and a bare go-ahead', () => {
  for (const p of ['', 'add a flag, it must print JSON', Array(70).fill('word').join(' '), 'go ahead', 'ok do it']) {
    assert.deepStrictEqual(intent.readIntent(p), { name: '', line: '', pattern: '' }, p);
  }
});

test('the pattern table is exported with what the eval needs', () => {
  assert.deepStrictEqual(intent.PRECISE.map((p) => p.id), ['show', 'vague', 'sweep', 'degree', 'narrow-path']);
  for (const p of intent.PRECISE) {
    assert.strictEqual(typeof p.test, 'function', p.id);
    assert.ok(Array.isArray(p.gold) && p.gold.length, p.id);
    assert.ok(['kind', 'text'].includes(p.on), p.id);
    assert.ok(p.line('x').length <= 240, p.id);
  }
});

test('regex mode restores the v9 lines', () => {
  const line = (p) => intent.intentLine(p, { mode: 'regex' });
  assert.match(line('change the help symbol to be a ! and the history symbol to the help one'), /touch only what is named/);
  assert.match(line('add a back button to the settings page'), /where the user will see it/);
  assert.match(line('add more tests'), /small step only/);
  assert.strictEqual(intent.readIntent('add a footer', { mode: 'regex' }).name, 'FEATURE');
});

test('the hook injects the self line, and BUC_OFF=self or "intent": "regex" restores v9', () => {
  const p = 'add a back button to the settings page';
  assert.match(inject({ prompt: p, cwd: repo(), session_id: 'm1' }, tmp('buc-home-')), /Before editing, decide which this is/);
  const off = inject({ prompt: p, cwd: repo(), session_id: 'm2' }, tmp('buc-home-'), { BUC_OFF: 'self' });
  assert.match(off, /where the user will see it/);
  assert.doesNotMatch(off, /decide which this is/);
  const conf = inject({ prompt: p, cwd: repo({ '.claude/buc.json': '{"intent":"regex"}' }), session_id: 'm3' }, tmp('buc-home-'));
  assert.match(conf, /where the user will see it/);
  assert.strictEqual(intent.intentMode(repo()), 'self');
});

test('a commit habit stated in one repo is not injected in another', () => {
  const home = tmp('buc-home-');
  const a = repo();
  inject({ prompt: 'always commit after each small change', cwd: a, session_id: 'h1' }, home);
  assert.match(inject({ prompt: 'add a footer', cwd: a, session_id: 'h2' }, home), /Commit after each small completed change/);
  assert.doesNotMatch(inject({ prompt: 'add a footer', cwd: repo(), session_id: 'h3' }, home), /Commit after each small completed change/);
});
