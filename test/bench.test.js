'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sumTokens } = require('../bench/run');

const CASES = path.join(__dirname, '..', 'bench', 'cases');
const run = (c, script, dir) => spawnSync('sh', [path.join(CASES, c, script), dir]).status;

for (const c of fs.readdirSync(CASES).filter((n) => fs.existsSync(path.join(CASES, n, 'setup.sh'))).sort()) {
  test(`bench case ${c}: accept fails unsolved, passes solved`, () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), `benchtest-${c}-`));
    const dir = path.join(parent, 'work');
    try {
      assert.strictEqual(run(c, 'setup.sh', dir), 0);
      assert.notStrictEqual(run(c, 'accept.sh', dir), 0);
      assert.strictEqual(run(c, 'solve.sh', dir), 0);
      assert.strictEqual(run(c, 'accept.sh', dir), 0);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });
}

test('sumTokens sums input incl. cache across models', () => {
  const mu = { a: { inputTokens: 1, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, outputTokens: 4 }, b: { inputTokens: 10, outputTokens: 5 } };
  assert.deepStrictEqual(sumTokens(mu, null), { input: 16, output: 9 });
});

test('fake claude: resume round runs and counts an intervention', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'benchtest-fake-'));
  try {
    const log = path.join(parent, 'calls.log');
    const bin = path.join(parent, 'fake-claude');
    fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\necho '{"session_id":"sess-1","result":"done","num_turns":1,"total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":2}}'\n`, { mode: 0o755 });
    const out = path.join(parent, 'out.json');
    const r = spawnSync('node', [path.join(__dirname, '..', 'bench', 'run.js'), '--arms', 'plain', '--cases', 'trivial', '--n', '1', '--out', out],
      { encoding: 'utf8', env: { ...process.env, BUC_CLAUDE_BIN: bin } });
    assert.strictEqual(r.status, 0, r.stderr);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.strictEqual(calls.length, 3);
    assert.ok(calls[1].includes('--resume sess-1') && calls[1].includes('no, read what i asked again'));
    const [row] = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(row.first_try_pass, false);
    assert.strictEqual(row.final_pass, false);
    assert.strictEqual(row.interventions, 2);
    assert.strictEqual(row.tokens_to_accept, 21);
    assert.deepStrictEqual(row.rounds.map((x) => [x.round, x.accept_pass, x.reply_excerpt]), [[0, false, 'done'], [1, false, 'done'], [2, false, 'done']]);
    assert.strictEqual(row.rounds[1].prompt, 'no, read what i asked again');
    assert.deepStrictEqual(row.rounds[2].files_changed, []);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('sim-user: pass needs no intervention; a question gets the best-reading reply', () => {
  const { simulate } = require('../bench/sim-user');
  assert.strictEqual(simulate({ first: { result: 'ok' }, accept: () => true, resume: () => { throw new Error('no'); } }).interventions, 0);
  const sent = [];
  let ok = false;
  const r = simulate({ first: { result: 'Which one?' }, accept: () => ok, resume: (m) => { sent.push(m); ok = true; return { result: 'done' }; } });
  assert.deepStrictEqual(sent, ['use your best reading of what I asked']);
  assert.strictEqual(r.first_try_pass, false);
  assert.strictEqual(r.final_pass, true);
});

test('sim-user: a first-turn question is answered with the real follow-up, which is sent once', () => {
  const { simulate } = require('../bench/sim-user');
  const sent = [];
  const replies = ['Did you mean the intro?', 'done'];
  const r = simulate({ first: { result: 'Which screen?' }, accept: () => false, followup: 'the intro, not the menu', resume: (m) => { sent.push(m); return { result: replies.shift() }; } });
  assert.deepStrictEqual(sent, ['the intro, not the menu', 'use your best reading of what I asked']);
  assert.strictEqual(r.interventions, 2);
  const plain = [];
  simulate({ first: { result: 'done' }, accept: () => false, followup: 'fix the intro', resume: (m) => { plain.push(m); return { result: 'done' }; } });
  assert.deepStrictEqual(plain, ['fix the intro', 'no, read what i asked again']);
});

test('excludedIds reads the case itself or named cases; dropRules removes only those ids', () => {
  const { excludedIds, dropRules } = require('../bench/run');
  assert.deepStrictEqual(excludedIds('', 'no-emoji'), []);
  assert.deepStrictEqual(excludedIds('self', 'no-emoji'), ['icons-not-emoji']);
  assert.deepStrictEqual(excludedIds('self', 'trivial'), []);
  assert.deepStrictEqual(excludedIds('trivial,no-emoji', 'trivial'), ['icons-not-emoji']);
  assert.throws(() => excludedIds('no-such-case', 'trivial'), /unknown case/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchtest-drop-'));
  try {
    const file = path.join(dir, 'rules.json');
    fs.writeFileSync(file, JSON.stringify([{ id: 'a' }, { id: 'b' }]));
    assert.deepStrictEqual(dropRules(file, ['b', 'zz']), ['b']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ id: 'a' }]);
    assert.deepStrictEqual(dropRules(path.join(dir, 'missing.json'), ['a']), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fake claude: --exclude-rules-from self hides the case rule from the buc and CLAUDE.md arms', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'benchtest-loo-'));
  try {
    const log = path.join(parent, 'seen.log');
    const bin = path.join(parent, 'fake-claude');
    fs.writeFileSync(bin, `#!/bin/sh\ncat CLAUDE.md "$BUC_HOME/rules.json" >> "${log}" 2>/dev/null\necho '{"session_id":"s","result":"done"}'\n`, { mode: 0o755 });
    const home = path.join(parent, 'home');
    fs.mkdirSync(home);
    fs.copyFileSync(path.join(__dirname, '..', 'bench', 'fixtures', 'rules.json'), path.join(home, 'rules.json'));
    const out = path.join(parent, 'out.json');
    const go = (...extra) => {
      fs.rmSync(log, { force: true });
      const r = spawnSync('node', [path.join(__dirname, '..', 'bench', 'run.js'), '--arms', 'plain-claudemd,buc', '--cases', 'no-emoji', '--buc-home', home, '--out', out, ...extra],
        { encoding: 'utf8', env: { ...process.env, BUC_CLAUDE_BIN: bin } });
      assert.strictEqual(r.status, 0, r.stderr);
      return { seen: fs.readFileSync(log, 'utf8'), rows: JSON.parse(fs.readFileSync(out, 'utf8')) };
    };
    const base = go();
    assert.match(base.seen, /Never use emoji/);
    assert.deepStrictEqual(base.rows.map((r) => r.excluded_rules), [[], []]);
    const loo = go('--exclude-rules-from', 'self');
    assert.doesNotMatch(loo.seen, /Never use emoji/);
    assert.match(loo.seen, /Reply tersely/);
    assert.deepStrictEqual(loo.rows.map((r) => r.excluded_rules), [['icons-not-emoji'], ['icons-not-emoji']]);
    assert.match(fs.readFileSync(path.join(home, 'rules.json'), 'utf8'), /icons-not-emoji/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('roundEntry keeps the prompt, both ends of a long reply, the accept result and the patch', () => {
  const { roundEntry } = require('../bench/run');
  const diff = { stat: [{ file: 'a.js', added: 2, deleted: 1 }], patch: 'diff --git a/a.js b/a.js' };
  const e = roundEntry(1, 'fix it', { result: `${'x'.repeat(700)}Which one?`, exit: 0, total_cost_usd: 0.1 }, false, diff);
  assert.strictEqual(e.reply_excerpt.length, 600);
  assert.match(e.reply_tail, /Which one\?$/);
  assert.deepStrictEqual([e.round, e.prompt, e.accept_pass, e.files_changed, e.lines_changed, e.patch], [1, 'fix it', false, ['a.js'], 3, diff.patch]);
  const none = roundEntry(0, 'p', { result: null }, null, { stat: [], patch: '' });
  assert.deepStrictEqual([none.reply_excerpt, none.reply_tail, none.accept_pass], [null, null, null]);
});

test('patchOf includes new files and leaves them untracked', () => {
  const { patchOf } = require('../bench/run');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchtest-patch-'));
  try {
    const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).stdout;
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git('add', '.');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
    const d = patchOf(dir);
    assert.deepStrictEqual(d.stat.map((x) => x.file), ['new.txt']);
    assert.match(d.patch, /\+n/);
    assert.strictEqual(git('status', '--porcelain').trim(), '?? new.txt');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
