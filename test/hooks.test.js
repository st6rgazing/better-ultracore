'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const HOOKS = path.join(__dirname, '..', 'hooks');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function repo() {
  const dir = tmp('buc-hook-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'app.js'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

function hook(name, input, home) {
  const r = spawnSync('node', [path.join(HOOKS, name)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, BUC_HOME: home } });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

const seed = (home, rules) => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'rules.json'), JSON.stringify(rules));
};
const rule = (id, when, check = {}) => ({ id, rule: `Rule ${id}.`, when: { keywords: [], paths: [], promptKinds: [], ...when }, check, kind: 'process', count: 5, last_seen: new Date().toISOString(), violations: 0, pinned: false });

test('hooks.json registers the three hooks', () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(hooks), ['UserPromptSubmit', 'Stop', 'SessionEnd']);
  for (const e of Object.values(hooks)) assert.match(e[0].hooks[0].command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[\w-]+\.js"$/);
  const timeouts = Object.values(hooks).map((e) => e[0].hooks[0].timeout);
  assert.deepStrictEqual(timeouts, [10, 120, 30]);
});

test('inject prints nothing for irrelevant prompts and injects matched rules', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  seed(home, [rule('short-answers', { keywords: ['answer'] })]);
  assert.strictEqual(hook('inject.js', { prompt: 'fix the header', cwd: dir, session_id: 's1' }, home), null);
  const out = hook('inject.js', { prompt: 'give me the answer', cwd: dir, session_id: 's1' }, home);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /Rule short-answers\./);
});

test('inject stores the turn baseline only for rules with a check', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  seed(home, [rule('advice-means-no-edits', { keywords: ['tell'], promptKinds: ['advice'] }, { cmd: 'advice-no-edits' })]);
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x\n');
  hook('inject.js', { prompt: 'tell me what this does', cwd: dir, session_id: 's2' }, home);
  const turn = JSON.parse(fs.readFileSync(path.join(home, 'turn-s2.json'), 'utf8'));
  assert.strictEqual(turn.head, git(dir, 'rev-parse', 'HEAD'));
  assert.match(turn.porcelain, /dirty\.txt/);
  assert.deepStrictEqual(turn.rules, [{ id: 'advice-means-no-edits', cmd: 'advice-no-edits' }]);
});

test('inject: no remote → nothing; named ref → fetch-and-read hint; known ahead → stale line', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  seed(home, []);
  const ask = () => hook('inject.js', { prompt: 'look at main please', cwd: dir, session_id: 's3' }, home);
  assert.strictEqual(ask(), null);
  git(dir, 'remote', 'add', 'origin', dir);
  assert.match(ask().hookSpecificOutput.additionalContext, /git fetch origin main.*git show origin\/main:<path>/);
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.match(ask().hookSpecificOutput.additionalContext, /You named main/);
  fs.writeFileSync(path.join(dir, 'app.js'), 'b\n');
  git(dir, 'commit', '-qam', 'ahead');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'reset', '-q', '--hard', 'HEAD~1');
  assert.match(ask().hookSpecificOutput.additionalContext, /git show origin\/main:<path> after git fetch/);
});

test('stop-check blocks once, never when stop_hook_active, and counts the violation', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  seed(home, [rule('advice-means-no-edits', { keywords: ['tell'], promptKinds: ['advice'] }, { cmd: 'advice-no-edits' })]);
  hook('inject.js', { prompt: 'tell me what this does', cwd: dir, session_id: 's4' }, home);
  const turnFile = path.join(home, 'turn-s4.json');
  assert.strictEqual(hook('stop-check.js', { session_id: 's4', cwd: dir }, home), null);
  assert.ok(!fs.existsSync(turnFile), 'turn file removed after a passing stop');
  hook('inject.js', { prompt: 'tell me what this does', cwd: dir, session_id: 's4' }, home);
  fs.writeFileSync(path.join(dir, 'app.js'), 'edited\n');
  const out = hook('stop-check.js', { session_id: 's4', cwd: dir }, home);
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /^Fix before finishing: advice-no-edits: .*app\.js/);
  assert.ok(out.reason.length <= 600);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'rules.json'), 'utf8'))[0].violations, 1);
  assert.strictEqual(hook('stop-check.js', { session_id: 's4', cwd: dir, stop_hook_active: true }, home), null);
  assert.ok(!fs.existsSync(turnFile), 'turn file removed after the one block');
});

test('inject stores a redacted prompt in the turn file', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  seed(home, [rule('advice-means-no-edits', { keywords: ['tell'], promptKinds: ['advice'] }, { cmd: 'advice-no-edits' })]);
  hook('inject.js', { prompt: 'tell me what this does, token=abc123secretvalue', cwd: dir, session_id: 's4d' }, home);
  assert.ok(!fs.readFileSync(path.join(home, 'turn-s4d.json'), 'utf8').includes('abc123secretvalue'));
});

test('a prompt with nothing to check drops the previous turn file', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  seed(home, [rule('advice-means-no-edits', { keywords: ['tell'], promptKinds: ['advice'] }, { cmd: 'advice-no-edits' })]);
  hook('inject.js', { prompt: 'tell me what this does', cwd: dir, session_id: 's4b' }, home);
  hook('inject.js', { prompt: 'fix the header', cwd: dir, session_id: 's4b' }, home);
  fs.writeFileSync(path.join(dir, 'app.js'), 'edited\n');
  assert.strictEqual(hook('stop-check.js', { session_id: 's4b', cwd: dir }, home), null);
});

test('checks run from the repo root when the prompt came from a subdirectory', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  seed(home, [rule('advice-means-no-edits', { keywords: ['tell'], promptKinds: ['advice'] }, { cmd: 'advice-no-edits' })]);
  fs.mkdirSync(path.join(dir, 'sub'));
  const sub = path.join(dir, 'sub');
  hook('inject.js', { prompt: 'tell me what this does', cwd: sub, session_id: 's4c' }, home);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'turn-s4c.json'), 'utf8')).root, fs.realpathSync(dir));
  fs.writeFileSync(path.join(sub, 'b.js'), 'x\n');
  const out = hook('stop-check.js', { session_id: 's4c', cwd: sub }, home);
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /files changed: sub\//);
});

test('stop-check output carries no secret values', () => {
  const dir = repo();
  const home = tmp('buc-home-');
  seed(home, [rule('exact', { keywords: ['change'] }, { cmd: 'exact-copy' })]);
  const secret = 'sk-abcdefghijklmnop1234';
  hook('inject.js', { prompt: `change 'app.js' to "${secret}"`, cwd: dir, session_id: 's5' }, home);
  const out = hook('stop-check.js', { session_id: 's5', cwd: dir }, home);
  assert.ok(!JSON.stringify(out).includes(secret));
});

test('session-end appends corrective turns redacted and bumps matching rules', () => {
  const home = tmp('buc-home-');
  seed(home, [rule('no-overlap', { keywords: ['overlap'] }), rule('other', { keywords: ['zzz'] })]);
  const line = (text) => JSON.stringify({ type: 'user', sessionId: 's6', message: { content: text } });
  const transcript = path.join(home, 't.jsonl');
  fs.writeFileSync(transcript, [
    line('please add a header to the page'),
    line('no, the panels still overlap. token=abc123secretvalue'),
    line('<system-reminder>no, stop</system-reminder>'),
    line('x'.repeat(500)),
  ].join('\n'));
  hook('session-end.js', { transcript_path: transcript, cwd: '/x' }, home);
  const inbox = fs.readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(inbox.length, 1);
  assert.ok(!inbox[0].text.includes('abc123secretvalue'));
  const rules = JSON.parse(fs.readFileSync(path.join(home, 'rules.json'), 'utf8'));
  assert.deepStrictEqual(rules.map((r) => r.count), [6, 5]);
});

test('session-end ignores a repeated session and keywords without word characters', () => {
  const home = tmp('buc-home-');
  seed(home, [rule('no-overlap', { keywords: ['overlap'] }), rule('symbols', { keywords: ['!!', '--'] })]);
  const transcript = path.join(home, 't.jsonl');
  fs.writeFileSync(path.join(home, 't.jsonl'), JSON.stringify({ type: 'user', sessionId: 's7', message: { content: 'no, the panels still overlap' } }));
  for (let i = 0; i < 3; i++) hook('session-end.js', { transcript_path: transcript, cwd: '/x' }, home);
  const inbox = fs.readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(inbox.length, 1);
  const rules = JSON.parse(fs.readFileSync(path.join(home, 'rules.json'), 'utf8'));
  assert.deepStrictEqual(rules.map((r) => r.count), [6, 5]);
  assert.deepStrictEqual(rules[0].bumped_sessions, ['s7']);
});

test('buc learn --dry-run skips subagent and temp dirs', () => {
  const root = tmp('buc-proj-');
  const line = (t) => JSON.stringify({ type: 'user', sessionId: 'sx', message: { content: t } });
  for (const d of ['app', 'app/subagents', '-private-tmp-bench-run']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'a.jsonl'), line('no, keep it smaller'));
  fs.writeFileSync(path.join(root, 'app', 'subagents', 'b.jsonl'), line('no, subagent turn'));
  fs.writeFileSync(path.join(root, '-private-tmp-bench-run', 'c.jsonl'), line('no, bench turn'));
  const r = spawnSync('node', [path.join(__dirname, '..', 'bin', 'buc'), 'learn', '--dry-run', '--projects-root', root], { encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(r.stdout).map((c) => c.text), ['no, keep it smaller']);
});
