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

const queuedLine = (min, prompt, kind = 'human') => ({ type: 'attachment', sessionId: SID, timestamp: T(min), cwd: '/r', gitBranch: 'main', attachment: { type: 'queued_command', prompt, origin: { kind } } });

test('parseSession: a message typed while the agent was busy is a turn, once, with its own id space', () => {
  const dir = tmp('queued');
  try {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, [
      user(1, 'add a late fee to the yearly plan', '/r'),
      queuedLine(2, 'no late fee on the free plan'),
      tool(3, 'Edit', { file_path: 'fee.txt' }),
      queuedLine(4, '<task-notification>done</task-notification>', 'task'),
      queuedLine(5, [{ type: 'image', source: {} }, { type: 'text', text: 'this one is cut off' }]),
      queuedLine(6, 'make the header darker please'),
      user(7, 'make the header darker please', '/r'),
      user(8, 'thanks, now the footer as well', '/r'),
    ].map((l) => JSON.stringify(l)).join('\n'));
    const { turns } = mc.parseSession(file);
    assert.deepStrictEqual(turns.map((t) => [t.idx, t.n, !!t.queued, t.text]), [
      [0, '000', false, 'add a late fee to the yearly plan'],
      [1, 'q000', true, 'no late fee on the free plan'],
      [2, 'q001', true, 'this one is cut off'],
      [3, '001', false, 'make the header darker please'],
      [4, '002', false, 'thanks, now the footer as well'],
    ]);
    assert.strictEqual(turns[1].edits, 1);
    assert.strictEqual(turns[2].image, true);
    assert.strictEqual(turns[1].cwd, '/r');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('parseSession: a leading harness reminder is dropped, the typed text kept; a brief from another session is not a turn', () => {
  const dir = tmp('reminder');
  try {
    const file = path.join(dir, 's.jsonl');
    const rem = '<system-reminder>\nLinked sessions now: a (idle).\n</system-reminder>\n\n';
    fs.writeFileSync(file, [
      user(1, `${rem}Task (from the session that started this one):\nBuild the shop.`, '/r'),
      user(2, `${rem}\nthe cards are still off centre`, '/r'),
      user(3, rem, '/r'),
      user(4, 'something with a <system-reminder>x</system-reminder> inside', '/r'),
    ].map((l) => JSON.stringify(l)).join('\n'));
    assert.deepStrictEqual(mc.parseSession(file).turns.map((t) => t.text), ['the cards are still off centre']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

test('criteria: each mechanical reject has its reason', () => {
  const ctx = { labels: { 'aaaaaaaa-001': { label: 'correction' } }, rules: RULES, visible: [], used: [], skipRepos: ['/r/plugin'] };
  assert.strictEqual(mc.rejectCorrection(cand(), ctx), null);
  const why = (over, c = ctx) => mc.rejectCorrection(cand(over), c);
  assert.strictEqual(why({ repo: null }), 'no repo for cwd');
  assert.strictEqual(why({ repo: '/r/plugin/sub' }), 'excluded repo');
  assert.strictEqual(why({ p: { text: 'x '.repeat(81), image: false } }), 'P over 80 words');
  assert.strictEqual(why({ p: { text: 'change the header colour to dark green please', image: true } }), 'P has an image');
  assert.strictEqual(why({ p: { text: 'still broken', image: false } }), 'P not standalone');
  assert.strictEqual(why({ fix: null }), 'no fix commit after C');
  assert.strictEqual(why({ fix_lines: 301 }), 'base..fix over 300 lines');
  assert.strictEqual(why({ work: 0 }), 'no assistant edits after P');
  assert.strictEqual(why({}, { ...ctx, labels: {} }), 'unlabelled');
  assert.match(why({}, { ...ctx, labels: { 'aaaaaaaa-001': { label: 'new-request' } } }), /not a correction/);
  assert.strictEqual(why({}, { ...ctx, used: [{ session: 's1', idx: 5 }] }), 'within 3 turns of an existing case');
  assert.strictEqual(why({}, { ...ctx, used: [{ session: 's1', idx: 6 }] }), null);
  const ctl = { ...ctx, labels: { 'aaaaaaaa-001': { label: 'accepted' } } };
  const ok = cand({ ack: true, c: { idx: 3, text: 'add a dark mode toggle', cue: false, visible: false } });
  assert.strictEqual(mc.rejectControl(ok, ctl), null);
  assert.strictEqual(mc.rejectControl({ ...ok, ack: false }, ctl), 'no go-ahead after the request');
  assert.strictEqual(mc.rejectControl(cand({ ack: true }), ctl), 'next turn has a correction cue');
});

test('chain: a corrected correction becomes one case with the later fix', () => {
  const fx = fixture();
  try {
    const a = cand({ id: 'aaaaaaaa-001', idx: 1, repo: fx.repo, base: fx.sha.base, fix: fx.sha.wrong, c: { idx: 2, text: 'centre it', cue: false, visible: false } });
    const b = cand({ id: 'aaaaaaaa-002', idx: 2, repo: fx.repo, base: fx.sha.wrong, fix: fx.sha.fix, p: { text: 'centre it' }, c: { idx: 4, text: 'under the title', cue: false, visible: false } });
    const other = cand({ id: 'aaaaaaaa-004', idx: 4, c: { idx: 5, text: 'new thing', cue: false, visible: false } });
    const labels = { 'aaaaaaaa-001': { label: 'correction' }, 'aaaaaaaa-002': { label: 'correction' }, 'aaaaaaaa-004': { label: 'new-request' } };
    const r = mc.chain([a, b, other], labels);
    assert.deepStrictEqual(r.cands.map((c) => c.id), ['aaaaaaaa-001', 'aaaaaaaa-004']);
    assert.strictEqual(r.cands[0].fix, fx.sha.fix);
    assert.strictEqual(r.cands[0].last_idx, 4);
    assert.deepStrictEqual(r.cands[0].later, ['under the title']);
    assert.strictEqual(r.cands[0].c.text, 'centre it');
    assert.strictEqual(r.absorbed.get('aaaaaaaa-002'), 'aaaaaaaa-001');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

const pool = () => {
  const out = [];
  let n = 0;
  for (const repo of ['/r/one', '/r/two', '/r/three']) for (let i = 0; i < 8; i++) {
    n++;
    out.push({ id: `c${String(n).padStart(2, '0')}`, session: `s${n}`, idx: 1, repo, kind: ['show', 'wide', 'narrow', 'other'][i % 4], ui: i % 2 === 0, c: { idx: 2, visible: i % 3 === 0 } });
  }
  return out;
};

test('sample: seeded, reproducible, within quotas', () => {
  const a = mc.sample(pool(), { seed: 10 });
  assert.deepStrictEqual(a.map((c) => c.id), mc.sample(pool(), { seed: 10 }).map((c) => c.id));
  assert.notDeepStrictEqual(a.map((c) => c.id), mc.sample(pool(), { seed: 11 }).map((c) => c.id));
  assert.strictEqual(a.length, 12);
  const count = (f) => a.filter(f).length;
  for (const r of ['/r/one', '/r/two', '/r/three']) assert.ok(count((c) => c.repo === r) <= 5 && count((c) => c.repo === r) >= 1);
  assert.ok(count((c) => !c.ui) >= 4);
  assert.ok(count((c) => c.kind === 'wide') >= 2);
  assert.ok(count((c) => c.kind === 'narrow') >= 2);
  assert.ok(count((c) => c.kind === 'show') >= 1);
  // a skipped id never comes back and does not reshuffle the rest
  const b = mc.sample(pool(), { seed: 10, skip: [a[0].id] });
  assert.ok(!b.some((c) => c.id === a[0].id));
  assert.deepStrictEqual(mc.shuffle(pool(), 10).map((c) => c.id), mc.shuffle(pool().reverse(), 10).map((c) => c.id));
});

test('sample: fewer survivors than the target ships fewer, and neighbours in one session are not both picked', () => {
  const few = [
    { id: 'a', session: 's', idx: 10, repo: '/r', kind: 'other', ui: true, c: { idx: 11, visible: false } },
    { id: 'b', session: 's', idx: 12, repo: '/r', kind: 'other', ui: true, c: { idx: 13, visible: false } },
    { id: 'c', session: 's', idx: 30, repo: '/r', kind: 'other', ui: true, c: { idx: 31, visible: false } },
  ];
  const got = mc.sample(few, { seed: 10 }).map((c) => c.id).sort();
  assert.strictEqual(got.length, 2);
  assert.ok(got.includes('c'));
});

// A case dir over the fixture repo; accept passes when fee.txt holds one of `passing`.
function caseDir(fx, passing) {
  const dir = path.join(fx.dir, `case-${passing.join('-')}`);
  mc.writeCase(dir, { repo: fx.repo, base: fx.sha.base, wrong: fx.sha.wrong, done: fx.sha.wrong, fix: fx.sha.fix, session: SID, p: { text: 'P text', ts: T(10) }, c: { text: 'C text' }, kind: 'wide', ui: false });
  fs.writeFileSync(path.join(dir, 'accept.sh'), `#!/bin/sh\ncd "$1" || exit 1\n${passing.map((w) => `grep -qx ${w} fee.txt && exit 0`).join('\n')}\nexit 1\n`, { mode: 0o755 });
  return dir;
}

test('writeCase writes the mechanical files; the dry check passes a good case', () => {
  const fx = fixture();
  try {
    const dir = caseDir(fx, ['right']);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['accept.sh', 'case.json', 'followup.txt', 'prompt.txt', 'setup.sh', 'solve.sh', 'wrong.sh']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'followup.txt'), 'utf8'), 'C text\n');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
    assert.deepStrictEqual([meta.base, meta.wrong, meta.fix, meta.control], [fx.sha.base, fx.sha.wrong, fx.sha.fix, false]);
    const r = mc.verifyCase(dir);
    assert.deepStrictEqual([r.base_fails, r.wrong_fails, r.fix_passes, r.ok], [true, true, true, true]);
    // the source repo is only cloned from
    assert.strictEqual(spawnSync('git', ['-C', fx.repo, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('the dry check rejects a case whose wrong passes, and one whose base passes', () => {
  const fx = fixture();
  try {
    const loose = mc.verifyCase(caseDir(fx, ['right', 'wrong']));
    assert.strictEqual(loose.wrong_fails, false);
    assert.strictEqual(loose.ok, false);
    const vacuous = mc.verifyCase(caseDir(fx, ['right', 'wrong', 'old']));
    assert.strictEqual(vacuous.base_fails, false);
    assert.strictEqual(vacuous.ok, false);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('a control has no follow-up and no wrong state', () => {
  const fx = fixture();
  try {
    const dir = path.join(fx.dir, 'ctl');
    mc.writeCase(dir, { control: true, repo: fx.repo, base: fx.sha.base, wrong: fx.sha.wrong, done: fx.sha.wrong, fix: null, session: SID, p: { text: 'P', ts: T(10) }, c: { text: 'next' } });
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['case.json', 'prompt.txt', 'setup.sh', 'solve.sh']);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8')).fix, fx.sha.wrong);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('manifest holds only ids and hashes and detects any change', () => {
  const fx = fixture();
  try {
    const root = path.join(fx.dir, 'held');
    fs.mkdirSync(root);
    fs.cpSync(caseDir(fx, ['right']), path.join(root, 'ho-01'), { recursive: true });
    fs.writeFileSync(path.join(root, 'SELECTION.md'), 'private notes');
    const m = mc.manifest(root);
    assert.deepStrictEqual(Object.keys(m.cases), ['ho-01']);
    assert.ok(Object.values(m.cases['ho-01']).every((h) => /^[0-9a-f]{64}$/.test(h)));
    assert.ok(!JSON.stringify(m).includes('P text') && !JSON.stringify(m).includes(fx.repo));
    assert.deepStrictEqual(mc.checkManifest(root, m), []);
    fs.appendFileSync(path.join(root, 'ho-01', 'accept.sh'), '# edited\n');
    assert.deepStrictEqual(mc.checkManifest(root, m), ['ho-01']);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('select: criteria, chain and seeded sample end to end, with every reject logged', () => {
  const fx = fixture();
  try {
    const cands = mc.mine(fx.root);
    const labels = { '11111111-000': { label: 'correction' }, '11111111-002': { label: 'new-request' } };
    // the fixture lives under the system temp dir, which the criteria refuse unless told otherwise
    assert.ok(mc.select(cands, { labels, rules: RULES }, { seed: 10 }).rejects.every((x) => x.why === 'temp or bench dir'));
    const r = mc.select(cands, { labels, rules: RULES, visible: [], used: [], skipRepos: [], allowTemp: true }, { seed: 10 });
    assert.deepStrictEqual(r.picked.map((c) => c.id), ['11111111-000']);
    assert.strictEqual(r.picked[0].kind, 'wide');
    assert.strictEqual(r.picked[0].ui, false);
    assert.strictEqual(r.eligible, 1);
    assert.ok(r.rejects.some((x) => x.id === '11111111-002' && x.as === 'correction'));
    assert.ok(r.rejects.filter((x) => x.as === 'control').length === 2);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('mine-cases CLI: mine, select, write, verify and manifest run end to end', () => {
  const fx = fixture();
  try {
    const cli = (...a) => spawnSync('node', [path.join(__dirname, '..', 'bench', 'mine-cases.js'), ...a], { encoding: 'utf8' });
    const out = path.join(fx.dir, 'held');
    const cands = path.join(out, 'candidates.jsonl');
    assert.strictEqual(cli('mine', '--root', fx.root, '--out', cands).status, 0);
    fs.writeFileSync(path.join(out, 'labels.json'), JSON.stringify({ '11111111-000': { label: 'correction' }, '11111111-002': { label: 'new-request' } }));
    const sel = cli('select', '--candidates', cands, '--labels', path.join(out, 'labels.json'), '--seed', '10', '--allow-temp', '--out', path.join(out, 'selection.json'));
    assert.strictEqual(sel.status, 0, sel.stderr);
    assert.deepStrictEqual(JSON.parse(sel.stdout).picked, ['11111111-000']);
    assert.strictEqual(cli('write', '--selection', path.join(out, 'selection.json'), '--out', out).status, 0);
    fs.writeFileSync(path.join(out, 'ho-01', 'accept.sh'), '#!/bin/sh\ngrep -qx right "$1/fee.txt"\n', { mode: 0o755 });
    const v = cli('verify', '--dir', out);
    assert.strictEqual(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /ho-01: base fails=true wrong fails=true fix passes=true/);
    const mf = path.join(fx.dir, 'manifest.json');
    assert.strictEqual(cli('manifest', '--dir', out, '--out', mf).status, 0);
    assert.strictEqual(cli('manifest', '--dir', out, '--check', mf).status, 0);
    fs.appendFileSync(path.join(out, 'ho-01', 'prompt.txt'), 'x');
    assert.strictEqual(cli('manifest', '--dir', out, '--check', mf).status, 1);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('backfill-sources maps rules to mined corrections by keyword and stores no text', () => {
  const bf = require('../bench/backfill-sources');
  const turns = [
    { session: 's1', cwd: '/nonexistent/app', ts: T(1), text: 'no emoji, use an icon' },
    { session: 's1', cwd: '/nonexistent/app', ts: T(2), text: 'no emoji, use an icon' },
    { session: 's2', cwd: '/nonexistent/app', ts: T(3), text: 'dont commit that yet' },
    { session: 's2', cwd: '/nonexistent/app', ts: T(4), text: 'please add an icon to the button' },
  ];
  const m = bf.backfill([...RULES, { id: 'bare' }], turns);
  assert.strictEqual(m['icons-not-emoji'].length, 1);
  assert.deepStrictEqual(Object.keys(m['icons-not-emoji'][0]), ['session', 'repo', 'ts', 'h']);
  assert.match(m['icons-not-emoji'][0].h, /^[0-9a-f]{12}$/);
  assert.strictEqual(m['small-commits'][0].session, 's2');
  assert.deepStrictEqual(m.bare, []);
  assert.ok(!JSON.stringify(m).includes('emoji,'));
  // a stricter threshold maps fewer
  assert.strictEqual(bf.backfill(RULES, turns, { min: 3 })['icons-not-emoji'].length, 0);
});

test('backfill-sources CLI prints a mapping and leaves rules.json untouched', () => {
  const fx = fixture();
  try {
    const rules = path.join(fx.dir, 'rules.json');
    fs.writeFileSync(rules, JSON.stringify([{ id: 'fees', when: { keywords: ['fee', 'yearly'] } }]));
    const before = fs.readFileSync(rules, 'utf8');
    fs.appendFileSync(fx.file, `\n${JSON.stringify(user(40, 'no the yearly fee', fx.repo))}`);
    const p = spawnSync('node', [path.join(__dirname, '..', 'bench', 'backfill-sources.js'), '--rules', rules, '--root', fx.root], { encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stderr);
    const m = JSON.parse(p.stdout);
    assert.strictEqual(m.fees.length, 1);
    assert.strictEqual(m.fees[0].repo, fx.repo);
    assert.strictEqual(fs.readFileSync(rules, 'utf8'), before);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});


test('the committed held-out manifest holds only case ids, file names and sha256 hashes', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'heldout.manifest.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(m).sort(), ['algorithm', 'cases', 'version']);
  assert.strictEqual(m.algorithm, 'sha256');
  for (const [id, files] of Object.entries(m.cases)) {
    assert.match(id, /^ho-(ctl-)?\d\d$/);
    for (const f of ['setup.sh', 'accept.sh', 'solve.sh', 'prompt.txt', 'case.json']) assert.ok(files[f], `${id} ${f}`);
    for (const [name, h] of Object.entries(files)) {
      assert.match(name, /^[a-z-]+\.(sh|txt|json|md|mts|mjs)$/);
      assert.match(h, /^[0-9a-f]{64}$/);
    }
  }
});
