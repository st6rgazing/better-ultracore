'use strict';
const test = require('node:test');
const assert = require('node:assert');
const stats = require('../bench/stats');

test('rng is deterministic per seed and stays in [0,1)', () => {
  const a = stats.rng(10);
  const b = stats.rng(10);
  const c = stats.rng(11);
  const xs = Array.from({ length: 50 }, () => a());
  assert.deepStrictEqual(xs, Array.from({ length: 50 }, () => b()));
  assert.notStrictEqual(xs[0], c());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('value reads keys, functions and booleans', () => {
  assert.strictEqual(stats.value({ interventions: 2 }, 'interventions'), 2);
  assert.strictEqual(stats.value({ first_try_pass: true }, 'first_try_pass'), 1);
  assert.strictEqual(stats.value({ a: 1 }, (r) => r.a + 1), 2);
  assert.strictEqual(stats.value({}, 'missing'), null);
});

const ROWS = [
  { case: 'x', arm: 'buc', interventions: 0 }, { case: 'x', arm: 'buc', interventions: 1 },
  { case: 'x', arm: 'plain', interventions: 2 }, { case: 'x', arm: 'plain', interventions: 2 },
  { case: 'y', arm: 'buc', interventions: 1 }, { case: 'y', arm: 'plain', interventions: 1 },
  { case: 'z', arm: 'buc', interventions: 0 },
  { case: 'y', arm: 'ultra', interventions: 9 },
];

test('caseDiffs pairs arms within a case and drops unpaired cases', () => {
  assert.deepStrictEqual(stats.caseDiffs(ROWS, 'buc', 'plain', 'interventions'), [{ case: 'x', diff: -1.5 }, { case: 'y', diff: 0 }]);
});

test('quantile interpolates', () => {
  assert.strictEqual(stats.quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.strictEqual(stats.quantile([0, 10], 0.25), 2.5);
  assert.strictEqual(stats.quantile([], 0.5), null);
});

test('pairedBootstrap: mean difference, reproducible interval, clustered by case', () => {
  const a = stats.pairedBootstrap(ROWS, 'buc', 'plain', 'interventions', { B: 2000, seed: 10 });
  assert.strictEqual(a.diff, -0.75);
  assert.strictEqual(a.cases, 2);
  assert.ok(a.lo <= a.diff && a.diff <= a.hi);
  assert.ok(a.lo >= -1.5 && a.hi <= 0);
  assert.deepStrictEqual(a, stats.pairedBootstrap(ROWS, 'buc', 'plain', 'interventions', { B: 2000, seed: 10 }));
  // Ten more reps of the same two cases must not narrow the interval: the unit is the case.
  const many = [];
  for (let i = 0; i < 10; i++) many.push(...ROWS);
  const b = stats.pairedBootstrap(many, 'buc', 'plain', 'interventions', { B: 2000, seed: 10 });
  assert.strictEqual(b.lo, a.lo);
  assert.strictEqual(b.hi, a.hi);
});

test('pairedBootstrap: a consistent effect excludes zero, no pairs gives nulls', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ case: `c${i}`, arm: 'buc', interventions: i % 3 === 0 ? 1 : 0 }, { case: `c${i}`, arm: 'plain', interventions: 1 + (i % 2) });
  const r = stats.pairedBootstrap(rows, 'buc', 'plain', 'interventions', { B: 3000 });
  assert.ok(r.hi < 0);
  assert.strictEqual(stats.pairedBootstrap([], 'buc', 'plain', 'interventions').diff, null);
});

test('stats CLI prints one JSON line', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
  try {
    fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify(ROWS));
    const p = spawnSync('node', [path.join(__dirname, '..', 'bench', 'stats.js'), path.join(dir, 'r.json'), '--B', '500'], { encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stderr);
    const o = JSON.parse(p.stdout);
    assert.strictEqual(o.diff, -0.75);
    assert.strictEqual(o.metric, 'interventions');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- held-out set: bench/mine-cases.js ----
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mc = require('../bench/mine-cases');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `v10-${name}-`));
const SID = '11111111-2222-3333-4444-555555555555';
const T = (min) => `2026-01-05T10:${String(min).padStart(2, '0')}:00.000Z`;
const user = (min, text, cwd, extra = {}) => ({ type: 'user', sessionId: SID, timestamp: T(min), cwd, gitBranch: 'main', message: { role: 'user', content: text }, ...extra });
const tool = (min, name, input) => ({ type: 'assistant', sessionId: SID, timestamp: T(min), message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });

// A repo with three dated commits (minutes 0, 12 and 22) and a transcript whose request, correction and next request sit around them.
function fixture() {
  const dir = tmp('mine');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const g = (args, min) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: T(min || 0), GIT_COMMITTER_DATE: T(min || 0), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
    const p = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
    if (p.status !== 0) throw new Error(p.stderr);
    return p.stdout.trim();
  };
  g(['init', '-q', '-b', 'main']);
  const commit = (min, body) => { fs.writeFileSync(path.join(repo, 'fee.txt'), body); g(['add', '-A']); g(['commit', '-q', '-m', `m${min}`], min); return g(['rev-parse', 'HEAD']); };
  const sha = { base: commit(0, 'old\n'), wrong: commit(12, 'wrong\n'), fix: commit(22, 'right\n') };
  const proj = path.join(dir, 'projects', '-Users-x-app');
  fs.mkdirSync(proj, { recursive: true });
  const real = fs.realpathSync(repo);
  const lines = [
    user(10, 'make the late fee five dollars instead of two', real),
    tool(11, 'Edit', { file_path: 'fee.txt' }),
    { type: 'user', sessionId: SID, timestamp: T(11), cwd: real, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    user(13, 'Deploy to live', real),
    user(20, 'not the monthly plan, the yearly plan fee', real),
    tool(21, 'Bash', { command: 'git commit -q -m fix' }),
    user(30, 'add a dark mode toggle to the header please', real),
    user(31, '<task-notification>ignored</task-notification>', real),
    user(32, 'side', real, { isSidechain: true }),
  ];
  const file = path.join(proj, `${SID}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  fs.mkdirSync(path.join(dir, 'projects', '-private-tmp-x'));
  fs.writeFileSync(path.join(dir, 'projects', '-private-tmp-x', 'a.jsonl'), '');
  return { dir, repo: real, file, sha, root: path.join(dir, 'projects') };
}

test('relayed keeps only human trigger messages and unescapes them', () => {
  const text = '<wake><message trigger="true" from="human" id="1">it&#39;s &lt;b&gt; broken</message><message trigger="false" from="human">old</message><message trigger="true" from="agent">bot</message></wake>';
  assert.deepStrictEqual(mc.relayed(text), ["it's <b> broken"]);
});

test('parseSession: user text turns in order with the work that followed; harness, sidechain and tool results are not turns', () => {
  const fx = fixture();
  try {
    const { turns, end } = mc.parseSession(fx.file);
    assert.deepStrictEqual(turns.map((t) => t.text), ['make the late fee five dollars instead of two', 'Deploy to live', 'not the monthly plan, the yearly plan fee', 'add a dark mode toggle to the header please']);
    assert.deepStrictEqual(turns.map((t) => [t.edits, t.commits]), [[1, 0], [0, 0], [0, 1], [0, 0]]);
    assert.strictEqual(turns[0].idx, 0);
    assert.strictEqual(turns[2].ts, T(20));
    assert.strictEqual(end, T(31));
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('transcripts skips temp project dirs', () => {
  const fx = fixture();
  try {
    assert.deepStrictEqual(mc.transcripts(fx.root), [fx.file]);
    assert.deepStrictEqual(mc.transcripts(fx.root, ['x-app']), []);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('resolveShas and diffStat resolve by timestamp', () => {
  const fx = fixture();
  try {
    assert.strictEqual(mc.repoOf(fx.repo), fx.repo);
    assert.strictEqual(mc.repoOf('/nonexistent/dir'), null);
    assert.deepStrictEqual(mc.resolveShas(fx.repo, 'HEAD', T(10), T(20), T(30)), { base: fx.sha.base, wrong: fx.sha.wrong, fix: fx.sha.fix, done: fx.sha.wrong });
    // no commit after the correction: no fix
    assert.strictEqual(mc.resolveShas(fx.repo, 'HEAD', T(10), T(25), T(30)).fix, null);
    assert.deepStrictEqual(mc.diffStat(fx.repo, fx.sha.base, fx.sha.fix), { lines: 2, files: ['fee.txt'] });
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('isOps: short go-aheads only', () => {
  for (const t of ['Deploy to live', 'push to live', 'yes go ahead', 'ok']) assert.ok(mc.isOps(t), t);
  for (const t of ['fix and push to live', 'push and also add a settings page with tabs for sound and display options', 'make it blue']) assert.ok(!mc.isOps(t), t);
});

test('a fixture transcript and repo yield the expected triple', () => {
  const fx = fixture();
  try {
    const all = mc.mine(fx.root);
    assert.strictEqual(all.length, 2);
    const c = all[0];
    assert.strictEqual(c.id, '11111111-000');
    assert.strictEqual(c.repo, fx.repo);
    assert.strictEqual(c.p.text, 'make the late fee five dollars instead of two');
    assert.strictEqual(c.c.text, 'not the monthly plan, the yearly plan fee');
    assert.strictEqual(c.c.idx, 2);
    assert.strictEqual(c.ack, true);
    assert.deepStrictEqual([c.base, c.wrong, c.fix], [fx.sha.base, fx.sha.wrong, fx.sha.fix]);
    assert.strictEqual(c.fix_lines, 2);
    assert.ok(c.work >= 2);
    assert.strictEqual(all[1].fix, null);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('standalone, kindOf, isUi', () => {
  assert.ok(mc.standalone('make the late fee five dollars instead of two'));
  for (const t of ['still', 'no not that one please', 'also add a button there', 'it does not work at all']) assert.ok(!mc.standalone(t), t);
  assert.strictEqual(mc.kindOf('undo your changes and just tell me the steps'), 'show');
  assert.strictEqual(mc.kindOf('not the whole page, just the header'), 'wide');
  assert.strictEqual(mc.kindOf('the footer links are still blue'), 'narrow');
  assert.strictEqual(mc.kindOf('make it blue'), 'other');
  assert.ok(mc.isUi(['src/App.tsx']));
  assert.ok(!mc.isUi(['server/rooms.ts']));
});

const RULES = [{ id: 'icons-not-emoji', when: { keywords: ['icon', 'emoji', 'button'] } }, { id: 'small-commits', when: { keywords: ['commit'] } }];
const cand = (over = {}) => ({ id: 'aaaaaaaa-001', session: 's1', idx: 1, repo: '/r/one', p: { text: 'change the header colour to dark green please', image: false }, c: { idx: 2, text: 'no the footer too', image: false, cue: true, visible: true }, ack: false, work: 1, base: 'b', wrong: 'w', fix: 'f', done: 'w', fix_lines: 10, fix_files: ['a.ts'], done_lines: 5, done_files: ['a.ts'], ...over });

test('jaccard and keywordHits', () => {
  assert.strictEqual(mc.jaccard('still not working', 'still not working!!'), 1);
  assert.strictEqual(mc.jaccard('alpha beta', 'gamma delta'), 0);
  assert.deepStrictEqual(mc.keywordHits('no emoji, use icons on the buttons', RULES), { rule: 'icons-not-emoji', hits: 3 });
  assert.strictEqual(mc.keywordHits('nothing here', RULES).hits, 0);
});

test('leaks: conservative on rule keywords and near-duplicates of mined corrections', () => {
  assert.strictEqual(mc.leaks(cand(), RULES, []), null);
  assert.match(mc.leaks(cand({ c: { idx: 2, text: 'no emoji use an icon', cue: true, visible: true } }), RULES, []), /leak: miner-visible/);
  // not visible to the miner, but request and correction together name the rule
  assert.match(mc.leaks(cand({ p: { text: 'add a button with an icon' }, c: { idx: 2, text: 'i meant something without any emoji in it at all', cue: false, visible: false } }), RULES, []), /request and correction/);
  const visible = [{ session: 's9', idx: 4, text: 'dont commit that yet' }];
  assert.match(mc.leaks(cand({ c: { idx: 2, text: 'dont commit that yet!', cue: true, visible: true } }), RULES, visible), /near-duplicate/);
});

