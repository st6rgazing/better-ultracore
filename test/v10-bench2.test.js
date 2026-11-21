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

// more tests below
