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
