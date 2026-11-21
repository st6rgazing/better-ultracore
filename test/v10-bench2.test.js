'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'bench', 'run.js');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `bench2-${name}-`));
const write = (file, text, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, mode ? { mode } : undefined); };

// A held-out style case: a one-file repo whose accept wants "fixed" in a.txt.
function heldoutCase(root, name, extra = {}) {
  const dir = path.join(root, name);
  write(path.join(dir, 'setup.sh'), '#!/bin/sh\nset -e\nmkdir -p "$1" && cd "$1" && git init -q && echo base > a.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm base\n');
  write(path.join(dir, 'accept.sh'), '#!/bin/sh\ngrep -q fixed "$1/a.txt"\n');
  write(path.join(dir, 'solve.sh'), '#!/bin/sh\necho fixed > "$1/a.txt"\n');
  write(path.join(dir, 'prompt.txt'), 'fix a.txt\n');
  if (extra.wrong) write(path.join(dir, 'wrong.sh'), `#!/bin/sh\necho ${extra.wrong} > "$1/a.txt"\n`);
  if (extra.json !== null) write(path.join(dir, 'case.json'), JSON.stringify({ session: 's-own', ts: '2026-06-01T00:00:00.000Z', control: false, ...extra.json }));
  return dir;
}

// Runs bench/run.js against a private set of case roots.
function bench(args, heldout, env = {}) {
  return spawnSync('node', [RUN, ...args], { encoding: 'utf8', env: { ...process.env, BUC_BENCH_HELDOUT: heldout, BUC_BENCH_PRIVATE: path.join(heldout, 'none'), ...env } });
}

test('held-out dirs are cases only with a case.json', () => {
  const root = tmp('heldout');
  try {
    heldoutCase(root, 'ho-a');
    heldoutCase(root, 'scratch', { json: null });
    const r = spawnSync('node', ['-e', `const { listCases } = require(${JSON.stringify(RUN)}); console.log(JSON.stringify([...listCases().keys()]));`],
      { encoding: 'utf8', env: { ...process.env, BUC_BENCH_HELDOUT: root, BUC_BENCH_PRIVATE: path.join(root, 'none') } });
    const names = JSON.parse(r.stdout);
    assert.ok(names.includes('ho-a'));
    assert.ok(!names.includes('scratch'));
    assert.ok(names.includes('trivial'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('dry run rejects a case whose wrong state passes accept', () => {
  const root = tmp('wrong');
  try {
    heldoutCase(root, 'ho-good', { wrong: 'nearly' });
    heldoutCase(root, 'ho-bad', { wrong: 'fixed' });
    const good = bench(['--dry', '--cases', 'ho-good'], root);
    assert.strictEqual(good.status, 0, good.stderr);
    assert.match(good.stdout, /ho-good: unsolved fails=true solved passes=true wrong fails=true/);
    const bad = bench(['--dry', '--cases', 'ho-bad'], root);
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stdout, /wrong fails=false/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const src = (session, ts, h, origin) => ({ session, repo: '/r', ts, h, ...(origin && { origin }) });
const rule = (id, extra = {}) => ({ id, rule: `Rule ${id}.`, when: { keywords: ['fix'], paths: [], promptKinds: [] }, check: {}, kind: 'process', count: 2, last_seen: '2026-09-01T00:00:00.000Z', violations: 0, pinned: false, ...extra });

// A store with one rule learned early, one learned only in the case's own session, one learned later and one without provenance.
function seededHome(dir) {
  write(path.join(dir, 'rules.json'), JSON.stringify([
    rule('early', { sources: [src('s-a', '2026-03-01T00:00:00.000Z', 'aaaaaaaaaaaa')] }),
    rule('own', { sources: [src('s-own', '2026-05-01T00:00:00.000Z', 'bbbbbbbbbbbb')] }),
    rule('late', { sources: [src('s-b', '2026-08-01T00:00:00.000Z', 'cccccccccccc')] }),
    rule('bare'),
  ]));
  return dir;
}

// Calls a bench/run.js export in a child process so the case roots can be set per test.
function callRun(expr, heldout) {
  const r = spawnSync('node', ['-e', `const run = require(${JSON.stringify(RUN)}); console.log(JSON.stringify(${expr}));`],
    { encoding: 'utf8', env: { ...process.env, BUC_BENCH_HELDOUT: heldout, BUC_BENCH_PRIVATE: path.join(heldout, 'none') } });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('mergeSources adds backfilled provenance and keeps what is there', () => {
  const { mergeSources } = require('../bench/run');
  const dir = tmp('merge');
  try {
    seededHome(dir);
    write(path.join(dir, 'sources.json'), JSON.stringify({ bare: [src('s-c', '2026-02-01T00:00:00.000Z', 'dddddddddddd')], early: [src('s-a', '2026-03-01T00:00:00.000Z', 'aaaaaaaaaaaa')], gone: [] }));
    assert.deepStrictEqual(mergeSources(path.join(dir, 'rules.json'), path.join(dir, 'sources.json')), ['early', 'bare']);
    const rules = JSON.parse(fs.readFileSync(path.join(dir, 'rules.json'), 'utf8'));
    assert.strictEqual(rules.find((r) => r.id === 'bare').sources.length, 1);
    assert.strictEqual(rules.find((r) => r.id === 'early').sources.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('asOfHome cuts at the case date and leaves out the case session', () => {
  const root = tmp('asof');
  try {
    heldoutCase(root, 'ho-a');
    const home = seededHome(path.join(root, 'home'));
    const out = path.join(root, 'out');
    const got = callRun(`run.asOfHome('ho-a', 'case', ${JSON.stringify(home)}, ${JSON.stringify(out)})`, root);
    assert.deepStrictEqual(got.kept, ['early']);
    assert.deepStrictEqual(got.dropped.sort(), ['bare', 'late', 'own']);
    assert.deepStrictEqual(got.excluded_sessions, ['s-own']);
    assert.strictEqual(got.before, '2026-06-01T00:00:00.000Z');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(out, 'rules.json'), 'utf8')).map((r) => r.id), ['early']);
    assert.ok(!fs.existsSync(`${out}-src`));
    // a fixed date keeps the case's own session; a synthetic case has nothing to cut at
    const fixed = callRun(`run.asOfHome('ho-a', '2026-07-01T00:00:00.000Z', ${JSON.stringify(home)}, ${JSON.stringify(path.join(root, 'out2'))})`, root);
    assert.deepStrictEqual(fixed.kept, ['early', 'own']);
    assert.strictEqual(callRun(`run.asOfHome('trivial', 'case', ${JSON.stringify(home)}, ${JSON.stringify(path.join(root, 'out3'))})`, root), null);
    // backfilled sources make an unsourced rule eligible
    write(path.join(root, 'sources.json'), JSON.stringify({ bare: [src('s-c', '2026-02-01T00:00:00.000Z', 'dddddddddddd')] }));
    const filled = callRun(`run.asOfHome('ho-a', 'case', ${JSON.stringify(home)}, ${JSON.stringify(path.join(root, 'out4'))}, ${JSON.stringify(path.join(root, 'sources.json'))})`, root);
    assert.deepStrictEqual(filled.kept.sort(), ['bare', 'early']);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'rules.json'), 'utf8')).find((r) => r.id === 'bare').sources, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A stand-in for claude: logs what the run could see, then prints a result. `body` runs in the run's repo.
function fakeClaude(dir, body = '') {
  const bin = path.join(dir, 'fake-claude');
  write(bin, `#!/bin/sh\n${body}\necho '{"session_id":"s","result":"done","num_turns":2,"total_cost_usd":0.02,"usage":{"input_tokens":5,"output_tokens":2}}'\n`, 0o755);
  return bin;
}

test('fake claude: --rules-as-of case gives the buc and CLAUDE.md arms the cut store only', () => {
  const root = tmp('asof-live');
  try {
    heldoutCase(root, 'ho-a', { json: { control: true } });
    const home = seededHome(path.join(root, 'home'));
    const log = path.join(root, 'seen.log');
    const bin = fakeClaude(root, `cat CLAUDE.md "$BUC_HOME/rules.json" >> "${log}" 2>/dev/null`);
    const out = path.join(root, 'out.json');
    const r = bench(['--arms', 'plain-claudemd,buc', '--cases', 'ho-a', '--buc-home', home, '--rules-as-of', 'case', '--out', out], root, { BUC_CLAUDE_BIN: bin });
    assert.strictEqual(r.status, 0, r.stderr);
    const seen = fs.readFileSync(log, 'utf8');
    assert.match(seen, /Rule early\./);
    assert.doesNotMatch(seen, /Rule (own|late|bare)\./);
    const rows = JSON.parse(fs.readFileSync(out, 'utf8'));
    for (const row of rows) {
      assert.deepStrictEqual(row.rules_as_of.kept, ['early']);
      assert.deepStrictEqual(row.rules_as_of.excluded_sessions, ['s-own']);
      assert.strictEqual(row.control, true);
    }
    const bad = bench(['--arms', 'buc', '--cases', 'ho-a', '--rules-as-of', 'case', '--out', out], root, { BUC_CLAUDE_BIN: bin });
    assert.notStrictEqual(bad.status, 0);
    assert.match(bad.stderr, /needs --buc-home/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('buc-regex arm runs the plugin with self-classification off', () => {
  const { ARMS, armOff } = require('../bench/run');
  assert.strictEqual(ARMS['buc-regex'].noPlugin, false);
  assert.strictEqual(armOff('buc-regex'), 'self');
  assert.strictEqual(armOff('buc-regex', 'shot, self'), 'shot,self');
  assert.strictEqual(armOff('buc', 'shot'), 'shot');
  const root = tmp('regex');
  try {
    heldoutCase(root, 'ho-a');
    const log = path.join(root, 'seen.log');
    const bin = fakeClaude(root, `echo "off=$BUC_OFF home=$BUC_HOME args=$*" >> "${log}"`);
    const r = bench(['--arms', 'buc,buc-regex', '--cases', 'ho-a', '--out', path.join(root, 'out.json')], root, { BUC_CLAUDE_BIN: bin, BUC_OFF: '' });
    assert.strictEqual(r.status, 0, r.stderr);
    const [buc, regex] = fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => !l.includes('--resume'));
    assert.match(buc, /^off= home=\S+buc-home /);
    assert.match(regex, /^off=self home=\S+buc-home /);
    assert.match(regex, /--plugin-dir/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('browserEnv lends a clone a Playwright and the browser cache', () => {
  const { browserEnv, playwrightIn } = require('../bench/run');
  const root = tmp('browser');
  try {
    const clone = path.join(root, 'clone');
    const source = path.join(root, 'source');
    const home = path.join(root, 'userhome');
    fs.mkdirSync(clone);
    write(path.join(source, 'web', 'node_modules', '@playwright', 'test', 'package.json'), '{}');
    fs.mkdirSync(path.join(home, 'Library', 'Caches', 'ms-playwright'), { recursive: true });
    assert.strictEqual(playwrightIn(clone), null);
    const lent = browserEnv(clone, { repo: source }, {}, home);
    assert.strictEqual(lent.BUC_PLAYWRIGHT, path.join(source, 'web', 'node_modules', '@playwright', 'test'));
    assert.strictEqual(lent.PLAYWRIGHT_BROWSERS_PATH, path.join(home, 'Library', 'Caches', 'ms-playwright'));
    // the caller's own settings win
    assert.deepStrictEqual(browserEnv(clone, { repo: source }, { BUC_PLAYWRIGHT: '/x', PLAYWRIGHT_BROWSERS_PATH: '/y' }, home), {});
    // a Playwright at the clone root is found by the plugin itself
    write(path.join(clone, 'node_modules', 'playwright', 'package.json'), '{}');
    assert.strictEqual(browserEnv(clone, { repo: source }, {}, path.join(root, 'nohome')).BUC_PLAYWRIGHT, undefined);
    assert.deepStrictEqual(browserEnv(clone, null, {}, path.join(root, 'nohome')), {});
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('each round records its own tokens, turns and time', () => {
  const { roundEntry } = require('../bench/run');
  const e = roundEntry(1, 'no', { result: 'ok', usage: { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 2 }, num_turns: 4, elapsed_ms: 900, total_cost_usd: 0.1 }, true, { stat: [], patch: '' });
  assert.deepStrictEqual([e.tokens, e.num_turns, e.elapsed_ms, e.accept_pass], [17, 4, 900, true]);
  assert.strictEqual(roundEntry(0, 'x', { result: null }, null, { stat: [], patch: '' }).tokens, null);
});

const stats = require('../bench/stats');

// Result rows: `first` and `final` are counts of passing runs out of n; interventions and tokens are per run.
function runs(c, arm, n, { first = n, final = n, interventions = 0, tokens = 1000, cost = 0.5, control = false } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    case: c, arm, rep: i + 1, first_try_pass: i < first, final_pass: i < final, control,
    interventions: i < first ? 0 : interventions || 1, tokens_to_accept: tokens, total_cost_usd: cost,
  }));
}

test('armSummary counts passes and averages per run', () => {
  const rows = [...runs('x', 'buc', 3, { first: 2, final: 3, interventions: 2, tokens: 900, cost: 0.4 }), ...runs('y', 'buc', 3, { first: 3 }), ...runs('x', 'plain', 3, { first: 0 })];
  const s = stats.armSummary(rows, 'buc');
  assert.deepStrictEqual([s.runs, s.cases, s.first_try, s.final], [6, 2, 5, 6]);
  assert.strictEqual(s.interventions, 2 / 6);
  assert.strictEqual(s.tokens_to_accept, 950);
  assert.ok(Math.abs(s.cost - 0.45) < 1e-9 && Math.abs(s.cost_total - 2.7) < 1e-9);
  assert.strictEqual(stats.armSummary(rows, 'ultra').interventions, null);
});

// 6 held-out cases, 3 runs each: buc first try everywhere, plain needs a correction on four of them.
const WIN = [
  ...['c1', 'c2', 'c3', 'c4'].flatMap((c) => [...runs(c, 'buc', 3), ...runs(c, 'plain', 3, { first: 1, interventions: 1 })]),
  ...['k1', 'k2'].flatMap((c) => [...runs(c, 'buc', 3, { control: true }), ...runs(c, 'plain', 3, { control: true })]),
];
const OLD_OK = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8'].flatMap((c) => runs(c, 'buc', 3, { first: 2 }));
const passes = (list) => list.map((x) => x.pass);

test('behindCases flags 2 of 3 and 3 of 5', () => {
  const rows = [...runs('x', 'buc', 3, { first: 1 }), ...runs('x', 'plain', 3), ...runs('y', 'buc', 3, { first: 2 }), ...runs('y', 'plain', 3),
    ...runs('z', 'buc', 5, { first: 3 }), ...runs('z', 'plain', 5), ...runs('w', 'buc', 5, { first: 2 }), ...runs('w', 'plain', 5)];
  assert.deepStrictEqual(stats.behindCases(rows, 'buc', 'plain').map((x) => x.case), ['x', 'w']);
});

test('criteria: all six pass on a clear win', () => {
  const got = stats.criteria(WIN, { regression: OLD_OK, B: 2000 });
  assert.deepStrictEqual(got.map((x) => x.id), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(passes(got), [true, true, true, true, true, true]);
  assert.match(got[5].detail, /16\/24 first try \(need 12\), 24\/24 final \(need 22\)/);
});

test('criteria: each one fails on its own evidence', () => {
  // 1: the same interventions in both arms
  const flat = ['c1', 'c2', 'c3'].flatMap((c) => [...runs(c, 'buc', 3, { first: 1 }), ...runs(c, 'plain', 3, { first: 1 })]);
  assert.deepStrictEqual(passes(stats.criteria(flat, { B: 500 })).slice(0, 4), [false, true, true, true]);
  // 2 and 4: buc loses a case outright
  const lost = [...WIN.filter((r) => r.control), ...runs('c1', 'buc', 3, { first: 0 }), ...runs('c1', 'plain', 3), ...runs('c5', 'buc', 3, { first: 0 }), ...runs('c5', 'plain', 3)];
  const l = stats.criteria(lost, { B: 500 });
  assert.strictEqual(l[1].pass, false);
  assert.strictEqual(l[3].pass, false);
  assert.match(l[3].detail, /c1 0 vs 3 of 3/);
  // 3: buc burns more tokens
  const heavy = WIN.map((r) => (r.arm === 'buc' ? { ...r, tokens_to_accept: 1100 } : r));
  assert.strictEqual(stats.criteria(heavy, { B: 500 })[2].pass, false);
  // 5: a control regresses
  const ctl = [...WIN.filter((r) => r.case !== 'k1'), ...runs('k1', 'buc', 3, { first: 2, control: true }), ...runs('k1', 'plain', 3, { control: true })];
  assert.strictEqual(stats.criteria(ctl, { B: 500 })[4].pass, false);
  // 6: too few old cases pass; no regression runs is not a pass either
  assert.strictEqual(stats.criteria(WIN, { regression: OLD_OK.map((r) => ({ ...r, first_try_pass: false })), B: 500 })[5].pass, false);
  assert.strictEqual(stats.criteria(WIN, { B: 500 })[5].pass, null);
  // unpaired cases are ignored
  assert.strictEqual(stats.criteria(runs('solo', 'buc', 3), { B: 500 })[0].pass, null);
});

test('verdict uses the pre-registered wording', () => {
  const v = (...p) => stats.verdict(p.map((pass, i) => ({ id: i + 1, pass })));
  assert.strictEqual(v(true, true, true, true, true, true), 'v10 generalises');
  assert.strictEqual(v(false, true, true, true, true, true), 'no measurable gain on unseen tasks');
  assert.strictEqual(v(true, false, true, true, true, true), 'regression: v10 does not ship');
  assert.strictEqual(v(false, true, true, false, true, true), 'regression: v10 does not ship');
  assert.strictEqual(v(true, true, true, true, null, null), 'incomplete: criteria 5, 6 not evaluated');
});

test('report prints the table, the intervals, six verdict lines and the wording', () => {
  const text = stats.report(WIN.map((r) => ({ ...r, rules_as_of: { kept: [] } })), { regression: OLD_OK, B: 500 });
  assert.match(text, /Held-out: buc against plain, 6 cases with both arms/);
  assert.match(text, /\| buc \| 18 \| 18\/18 \| 18\/18 \| 0\.00 \| 1000 \| 0\.500 \| 9\.00 \|/);
  assert.match(text, /\| plain \| 18 \| 10\/18 \|/);
  assert.match(text, /\| interventions \| -0\.444 \|/);
  assert.match(text, /\| first_try_pass \| 0\.444 \|/);
  assert.match(text, /\| tokens_to_accept \| 0 \|/);
  assert.strictEqual(text.match(/^\d\. PASS {2}/gm).length, 6);
  assert.match(text, /Verdict: v10 generalises$/);
  assert.doesNotMatch(text, /Warning/);
  const open = stats.report(WIN, { B: 500 });
  assert.match(open, /Warning: 18 buc runs were not made with --rules-as-of/);
  assert.match(open, /^6\. NO DATA {2}/m);
  assert.match(open, /Verdict: incomplete: criteria 6 not evaluated$/);
});

// more tests below
