'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/rules/store');
const handsoff = require('../lib/handsoff');
const mine = require('../lib/rules/mine');
const { retrieve, matches } = require('../lib/rules/retrieve');

const fresh = () => { process.env.BUC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-v10-')); return process.env.BUC_HOME; };
const withEnv = (vars, fn) => {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
};

test('now() honours BUC_NOW as an ISO date or epoch ms, else the wall clock', () => {
  withEnv({ BUC_NOW: '2026-01-02T03:04:05.000Z' }, () => assert.strictEqual(store.now(), Date.parse('2026-01-02T03:04:05.000Z')));
  withEnv({ BUC_NOW: '1700000000000' }, () => assert.strictEqual(store.now(), 1700000000000));
  withEnv({ BUC_NOW: 'garbage' }, () => assert.ok(Math.abs(store.now() - Date.now()) < 5000));
  withEnv({ BUC_NOW: undefined }, () => assert.ok(Math.abs(store.now() - Date.now()) < 5000));
});

test('BUC_NOW sets the default time of new rules', () => {
  fresh();
  withEnv({ BUC_NOW: '2026-01-02T03:04:05.000Z' }, () => {
    store.importRules([{ id: 'a-rule', rule: 'Do the thing.', when: { keywords: ['thing'] } }]);
    assert.strictEqual(store.loadRules()[0].last_seen, '2026-01-02T03:04:05.000Z');
  });
});

test('off() reads BUC_OFF and the repo buc.json off list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-off-'));
  withEnv({ BUC_OFF: undefined }, () => assert.strictEqual(store.off('self', root), false));
  withEnv({ BUC_OFF: 'self, wide-diff' }, () => {
    assert.strictEqual(store.off('self', root), true);
    assert.strictEqual(store.off('Wide-Diff', root), true);
    assert.strictEqual(store.off('typecheck', root), false);
  });
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'buc.json'), JSON.stringify({ off: ['typecheck'] }));
  withEnv({ BUC_OFF: 'self' }, () => {
    assert.strictEqual(store.off('typecheck', root), true);
    assert.strictEqual(store.off('self', root), true);
    assert.strictEqual(store.off('ui', root), false);
  });
  fs.writeFileSync(path.join(root, '.claude', 'buc.json'), JSON.stringify({ off: 'ui,shot' }));
  withEnv({ BUC_OFF: undefined }, () => assert.strictEqual(store.off('shot', root), true));
  fs.writeFileSync(path.join(root, '.claude', 'buc.json'), '{broken');
  withEnv({ BUC_OFF: undefined }, () => assert.strictEqual(store.off('shot', root), false));
});

test('repoState is empty for an unknown repo and reads repos.json', () => {
  const home = fresh();
  assert.deepStrictEqual(store.repoState('nope'), { events: [] });
  fs.writeFileSync(path.join(home, 'repos.json'), JSON.stringify({ r1: { handsOff: 'on' } }));
  assert.deepStrictEqual(store.repoState('r1'), { handsOff: 'on', events: [] });
  fs.writeFileSync(path.join(home, 'repos.json'), 'not json');
  assert.deepStrictEqual(store.repoState('r1'), { events: [] });
});

test('recordRepo appends named events per repo, caps them and never stores text', () => {
  const home = fresh();
  const st = store.recordRepo('r1', 'handsoff', 's1', '2026-03-01T00:00:00.000Z');
  assert.deepStrictEqual(st.events, [{ e: 'handsoff', s: 's1', ts: '2026-03-01T00:00:00.000Z' }]);
  store.recordRepo('r1', 'edit', 's2', Date.parse('2026-03-02T00:00:00.000Z'));
  store.recordRepo('r2', 'edit', 's3');
  assert.deepStrictEqual(store.repoState('r1').events.map((e) => [e.e, e.s, e.ts]), [['handsoff', 's1', '2026-03-01T00:00:00.000Z'], ['edit', 's2', '2026-03-02T00:00:00.000Z']]);
  assert.strictEqual(store.repoState('r2').events.length, 1);
  assert.strictEqual(store.recordRepo('', 'edit', 's1'), null);
  assert.strictEqual(store.recordRepo('r1', '', 's1'), null);
  for (let i = 0; i < 410; i++) store.recordRepo('r3', 'edit', 's', 1700000000000 + i);
  assert.strictEqual(store.repoState('r3').events.length, 400);
  assert.deepStrictEqual(Object.keys(store.repoState('r3').events[0]).sort(), ['e', 's', 'ts']);
  fs.writeFileSync(path.join(home, 'repos.json'), '{broken');
  assert.strictEqual(store.recordRepo('r1', 'edit', 's1'), null);
  assert.strictEqual(fs.readFileSync(path.join(home, 'repos.json'), 'utf8'), '{broken');
});

test('recordRepo defaults its time to BUC_NOW', () => {
  fresh();
  withEnv({ BUC_NOW: '2026-05-05T00:00:00.000Z' }, () => store.recordRepo('r1', 'edit', 's1'));
  assert.strictEqual(store.repoState('r1').events[0].ts, '2026-05-05T00:00:00.000Z');
});

test('setRepo sets and removes fields and keeps events', () => {
  fresh();
  store.recordRepo('r1', 'edit', 's1', 1700000000000);
  assert.strictEqual(store.setRepo('r1', { handsOff: 'on', events: [] }).handsOff, 'on');
  assert.strictEqual(store.repoState('r1').events.length, 1);
  store.setRepo('r1', { handsOff: undefined });
  assert.ok(!('handsOff' in store.repoState('r1')));
  assert.strictEqual(store.setRepo('', { handsOff: 'on' }), null);
});

test('saveLastTurn keeps head and files, and a call without rules merges', () => {
  fresh();
  store.saveLastTurn('s1', { rules: ['a'], repo: 'r1', ts: 5 });
  assert.deepStrictEqual(store.loadLastTurn('s1'), { rules: ['a'], repo: 'r1', ts: 5 });
  store.saveLastTurn('s1', { head: 'abc', files: { 'src/a.js': 'h1', 'new.js': null } });
  assert.deepStrictEqual(store.loadLastTurn('s1'), { rules: ['a'], repo: 'r1', ts: 5, head: 'abc', files: { 'src/a.js': 'h1', 'new.js': null } });
  store.saveLastTurn('s1', { rules: ['b'], repo: 'r1', ts: 6 });
  assert.deepStrictEqual(store.loadLastTurn('s1'), { rules: ['b'], repo: 'r1', ts: 6 });
  store.saveLastTurn('s2', { rules: [], repo: 'r1', ts: 7, head: 'h', files: {} });
  assert.deepStrictEqual(store.loadLastTurn('s2'), { rules: [], repo: 'r1', ts: 7, head: 'h', files: {} });
});

test('patchTurn merges v10 fields into the turn file and creates it when missing', () => {
  fresh();
  store.writeTurn('s1', { session_id: 's1', checks: ['typecheck'], intent: 'SELF' });
  assert.deepStrictEqual(store.patchTurn('s1', { toolCalls: 3, shotAt: 9 }), { session_id: 's1', checks: ['typecheck'], intent: 'SELF', toolCalls: 3, shotAt: 9 });
  assert.strictEqual(store.readTurn('s1').toolCalls, 3);
  assert.deepStrictEqual(store.patchTurn('s2', { toolCalls: 1 }), { session_id: 's2', toolCalls: 1 });
  assert.deepStrictEqual(store.readTurn('s2'), { session_id: 's2', toolCalls: 1 });
});

test('hands-off statements and apply prompts are recognised narrowly', () => {
  for (const p of ["don't change anything, what is wrong with the header?", 'undo your changes', 'Just show me the css', 'just tell me which file', 'show me how to add a route', 'do not edit anything yet']) assert.ok(handsoff.isStatement(p), p);
  for (const p of ['make the header blue', "don't change the footer", 'show me the result when done', 'undo the last commit', '']) assert.ok(!handsoff.isStatement(p), p);
  for (const p of ['apply', 'ok, do it', 'Go ahead', 'yes please apply that']) assert.ok(handsoff.isApply(p), p);
  for (const p of ['can you apply the theme to the footer', 'what would you do', '']) assert.ok(!handsoff.isApply(p), p);
});

const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const DAY = 86400000;
const seed = (repo, list) => { for (const [e, s, day] of list) store.recordRepo(repo, e, s, T0 + day * DAY); };
const modeAt = (repo, day) => handsoff.mode(repo, { now: T0 + day * DAY });

test('hands-off auto: threshold of three statements from two sessions', () => {
  fresh();
  assert.deepStrictEqual(modeAt('r', 0), { mode: 'auto-idle', events: 0, sessions: 0, edits: 0, ratio: 0 });
  seed('r', [['handsoff', 'a', 0], ['handsoff', 'b', 1]]);
  assert.strictEqual(modeAt('r', 2).mode, 'auto-idle');
  seed('r', [['handsoff', 'b', 2]]);
  assert.deepStrictEqual(modeAt('r', 3), { mode: 'auto-active', events: 3, sessions: 2, edits: 0, ratio: 1 });
});

test('hands-off auto: three statements in one session are not enough', () => {
  fresh();
  seed('r', [['handsoff', 'a', 0], ['handsoff', 'a', 1], ['handsoff', 'a', 2]]);
  assert.deepStrictEqual([modeAt('r', 3).mode, modeAt('r', 3).sessions], ['auto-idle', 1]);
});

test('hands-off auto: statements must be 30% of edit prompts', () => {
  fresh();
  seed('r', [['handsoff', 'a', 0], ['handsoff', 'b', 1], ['handsoff', 'b', 2]]);
  seed('r', Array.from({ length: 7 }, (_, i) => ['edit', 'c', i]));
  assert.deepStrictEqual([modeAt('r', 8).mode, modeAt('r', 8).ratio], ['auto-active', 0.3]);
  seed('r', [['edit', 'c', 7]]);
  assert.deepStrictEqual([modeAt('r', 8).mode, modeAt('r', 8).edits], ['auto-idle', 8]);
});

test('hands-off auto: an apply subtracts one', () => {
  fresh();
  seed('r', [['handsoff', 'a', 0], ['handsoff', 'b', 1], ['handsoff', 'b', 2], ['apply', 'b', 2]]);
  assert.deepStrictEqual([modeAt('r', 3).mode, modeAt('r', 3).events], ['auto-idle', 2]);
  seed('r', [['handsoff', 'c', 3]]);
  assert.strictEqual(modeAt('r', 4).mode, 'auto-active');
});

test('hands-off auto: events expire after 60 days and future events do not count', () => {
  fresh();
  seed('r', [['handsoff', 'a', 0], ['handsoff', 'b', 1], ['handsoff', 'b', 30]]);
  assert.strictEqual(modeAt('r', 59).mode, 'auto-active');
  assert.strictEqual(modeAt('r', 61).mode, 'auto-idle');
  assert.strictEqual(modeAt('r', 10).events, 2);
});

test('hands-off: an explicit setting overrides the evidence, and BUC_OFF=handsoff forces off', () => {
  fresh();
  store.setRepo('r', { handsOff: 'on' });
  assert.strictEqual(modeAt('r', 0).mode, 'on');
  seed('r', [['handsoff', 'a', 0], ['handsoff', 'b', 1], ['handsoff', 'b', 2]]);
  store.setRepo('r', { handsOff: 'off' });
  assert.strictEqual(modeAt('r', 3).mode, 'off');
  store.setRepo('r', { handsOff: 'auto' });
  assert.strictEqual(modeAt('r', 3).mode, 'auto-active');
  store.setRepo('r', { handsOff: 'on' });
  withEnv({ BUC_OFF: 'handsoff' }, () => assert.strictEqual(modeAt('r', 3).mode, 'off'));
});

test('handsoff.record stores statement, apply and edit events, names only', () => {
  const home = fresh();
  const rec = (prompt, sessionId, kind) => handsoff.record({ prompt, repo: 'r', sessionId, kind, ts: T0 });
  assert.strictEqual(rec('make the header blue', 'a'), 'edit');
  assert.strictEqual(rec('apply', 'a'), null);
  assert.strictEqual(rec("don't change anything, just tell me why the build fails", 'a'), 'handsoff');
  assert.strictEqual(rec('ok do it', 'a'), 'apply');
  assert.strictEqual(rec('go ahead', 'a'), null);
  assert.strictEqual(rec('explain how routing works, do not change the code', 'a'), null);
  assert.strictEqual(rec('why is this slow', 'a', 'advice'), null);
  assert.strictEqual(rec('', 'a'), null);
  assert.strictEqual(handsoff.record({ prompt: 'show me how', repo: null, sessionId: 'a' }), null);
  assert.strictEqual(handsoff.record(), null);
  assert.deepStrictEqual(store.repoState('r').events.map((e) => e.e), ['edit', 'handsoff', 'apply']);
  assert.ok(!/header|build|change/.test(fs.readFileSync(path.join(home, 'repos.json'), 'utf8')));
});

test('handsoff.record feeds mode through real prompts', () => {
  fresh();
  const rec = (prompt, sessionId, day) => handsoff.record({ prompt, repo: 'r', sessionId, ts: T0 + day * DAY });
  rec('show me how to add a tab', 'a', 0);
  rec('just show me the diff you would make', 'b', 1);
  rec('undo your changes', 'b', 2);
  rec('add a footer link', 'b', 3);
  assert.deepStrictEqual(modeAt('r', 4), { mode: 'auto-active', events: 3, sessions: 2, edits: 1, ratio: 0.75 });
  rec('go ahead', 'b', 4);
  assert.strictEqual(modeAt('r', 5).mode, 'auto-idle');
});

test('handsoff.set stores the setting and active follows mode', () => {
  fresh();
  assert.strictEqual(handsoff.active('r'), false);
  assert.strictEqual(handsoff.set('r', 'on').handsOff, 'on');
  assert.strictEqual(handsoff.active('r'), true);
  handsoff.set('r', 'off');
  assert.strictEqual(handsoff.active('r'), false);
  handsoff.set('r', 'auto');
  assert.strictEqual(handsoff.mode('r').mode, 'auto-idle');
  assert.throws(() => handsoff.set('r', 'maybe'), /on, off or auto/);
});

test('store.hash is 12 hex of the redacted text and stable under redaction', () => {
  assert.match(store.hash('no, only the header'), /^[0-9a-f]{12}$/);
  assert.strictEqual(store.hash('  no, only the header '), store.hash('no, only the header'));
  assert.notStrictEqual(store.hash('no, only the header'), store.hash('no, only the footer'));
  const { redact } = require('../lib/prefs/redact');
  const secret = 'no, the key is sk-ant-REDACTED';
  assert.strictEqual(store.hash(secret), store.hash(redact(secret)));
});

const RULE = { id: 'only-named', rule: 'Change only the named thing.', when: { keywords: ['only'] } };
const src = (session, day, h = 'aaaaaaaaaaaa', extra = {}) => ({ session, repo: 'r1', ts: new Date(T0 + day * DAY).toISOString(), h, ...extra });

test('normalize keeps origin, sources and scope, and never keeps text in sources', () => {
  const { rule } = store.normalize({ ...RULE, sources: [src('A', 0), src('A', 0), { session: 'B', repo: 'r2', ts: T0, h: 'zz', text: 'no, only the header' }, 'bbbbbbbbbbbb', {}, 7], scope: { repos: ['r1', 'r1', ''] } });
  assert.strictEqual(rule.origin, 'learn');
  assert.deepStrictEqual(rule.sources, [
    { session: 'A', repo: 'r1', ts: '2026-06-01T00:00:00.000Z', h: 'aaaaaaaaaaaa' },
    { session: 'B', repo: 'r2', ts: '2026-06-01T00:00:00.000Z', h: '' },
    { session: '', repo: '', ts: '', h: 'bbbbbbbbbbbb' },
  ]);
  assert.deepStrictEqual(rule.scope, { repos: ['r1'] });
  const plain = store.normalize(RULE).rule;
  assert.deepStrictEqual([plain.origin, plain.sources, plain.scope], ['import', undefined, undefined]);
  assert.strictEqual(store.normalize({ ...RULE, origin: 'habit' }).rule.origin, 'habit');
  assert.strictEqual(store.normalize({ ...RULE, origin: 'nonsense' }).rule.origin, 'import');
  assert.strictEqual(store.normalize({ ...RULE, sources: [src('A', 0, 'aaaaaaaaaaaa', { origin: 'bump' })] }).rule.origin, 'import');
});

test('importRules merges sources on upsert and keeps an existing scope and origin', () => {
  fresh();
  store.importRules([{ ...RULE, origin: 'habit', pinned: true, scope: { repos: ['r1'] }, sources: [src('A', 0)] }]);
  store.importRules([{ ...RULE, rule: 'Change only what was named.', sources: [src('A', 0), src('B', 1, 'bbbbbbbbbbbb')] }]);
  const [r] = store.loadRules();
  assert.deepStrictEqual([r.rule, r.origin, r.pinned, r.scope], ['Change only what was named.', 'habit', true, { repos: ['r1'] }]);
  assert.deepStrictEqual(r.sources.map((x) => x.session), ['A', 'B']);
});

test('importRules upgrades an import-origin rule to learn when sources arrive', () => {
  fresh();
  store.importRules([RULE]);
  assert.strictEqual(store.loadRules()[0].origin, 'import');
  store.importRules([{ ...RULE, sources: [src('A', 0)] }]);
  assert.strictEqual(store.loadRules()[0].origin, 'learn');
});

test('importRules fills bare source hashes from the inbox', () => {
  fresh();
  const text = 'no, only the header';
  store.appendInbox([
    { ts: '2026-06-02T00:00:00.000Z', session_id: 'S1', text, repo: 'r1', h: store.hash(text) },
    { ts: '2026-06-03T00:00:00.000Z', session_id: 'S0', text: 'still broken on mobile' },
  ]);
  store.importRules([{ ...RULE, sources: [store.hash(text), { h: store.hash('still broken on mobile') }, 'cccccccccccc'] }]);
  const [r] = store.loadRules();
  assert.deepStrictEqual(r.sources, [
    { session: 'S1', repo: 'r1', ts: '2026-06-02T00:00:00.000Z', h: store.hash(text) },
    { session: 'S0', repo: '', ts: '2026-06-03T00:00:00.000Z', h: store.hash('still broken on mobile') },
    { session: '', repo: '', ts: '', h: 'cccccccccccc' },
  ]);
  assert.strictEqual(r.origin, 'learn');
  assert.ok(!JSON.stringify(r).includes('header'));
});

test('bumpSessions appends bump sources once per session', () => {
  fresh();
  store.importRules([{ ...RULE, sources: [src('A', 0)] }]);
  store.bumpSessions({ 'only-named': ['B', src('C', 5, 'cccccccccccc'), 'B'] }, T0 + 9 * DAY);
  store.bumpSessions({ 'only-named': ['B'] }, T0 + 10 * DAY);
  const [r] = store.loadRules();
  assert.deepStrictEqual([r.count, r.bumped_sessions, r.last_seen], [3, ['B', 'C'], new Date(T0 + 9 * DAY).toISOString()]);
  assert.deepStrictEqual(r.sources.slice(1), [
    { session: 'B', repo: '', ts: new Date(T0 + 9 * DAY).toISOString(), h: '', origin: 'bump' },
    { session: 'C', repo: 'r1', ts: new Date(T0 + 5 * DAY).toISOString(), h: 'cccccccccccc', origin: 'bump' },
  ]);
});

test('asOf: excluding one of two sessions gives count 1, excluding both removes the rule, an early before removes it', () => {
  const rule = { ...store.normalize({ ...RULE, count: 6, sources: [src('A', 0), src('B', 10, 'bbbbbbbbbbbb')] }).rule, violations: 2, last_violation: 'x', byRepo: { r1: { hits: 1, misses: 3 } } };
  const all = store.asOf([rule], {});
  assert.deepStrictEqual([all[0].count, all[0].last_seen], [2, src('B', 10).ts]);
  const [noA] = store.asOf([rule], { excludeSessions: ['A'] });
  assert.deepStrictEqual([noA.count, noA.last_seen, noA.sources.map((s) => s.session), noA.violations, noA.byRepo, noA.last_violation], [1, src('B', 10).ts, ['B'], 0, undefined, undefined]);
  assert.deepStrictEqual(store.asOf([rule], { excludeSessions: ['A', 'B'] }), []);
  assert.deepStrictEqual(store.asOf([rule], { before: new Date(T0 - DAY).toISOString() }), []);
  assert.deepStrictEqual(store.asOf([rule], { before: src('A', 0).ts }), []);
  const [mid] = store.asOf([rule], { before: T0 + 5 * DAY });
  assert.deepStrictEqual([mid.count, mid.last_seen], [1, src('A', 0).ts]);
  assert.strictEqual(rule.count, 6);
});

test('asOf drops rules without a dated learn source and keeps bumps only beside one', () => {
  const mk = (id, extra) => store.normalize({ ...RULE, id, ...extra }).rule;
  const rules = [
    mk('no-sources', {}),
    mk('habit-rule', { origin: 'habit', pinned: true }),
    mk('bump-only', { sources: [src('A', 0, 'aaaaaaaaaaaa', { origin: 'bump' })] }),
    mk('undated', { sources: ['aaaaaaaaaaaa'] }),
    mk('learn-and-bump', { sources: [src('A', 0), src('B', 3, '', { origin: 'bump' }), src('C', 4, '', { origin: 'bump' })] }),
  ];
  const out = store.asOf(rules, { excludeSessions: ['C'] });
  assert.deepStrictEqual(out.map((r) => [r.id, r.count, r.bumped_sessions]), [['learn-and-bump', 2, ['B']]]);
  assert.deepStrictEqual(store.asOf(rules, { excludeSessions: ['A'] }), []);
  assert.throws(() => store.asOf(rules, { before: 'not a date' }), /bad --before/);
});

const transcript = (dir, name, entries) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n'));
  return f;
};
const userTurn = (sessionId, text, timestamp, cwd) => ({ type: 'user', sessionId, timestamp, cwd, message: { role: 'user', content: text } });

test('correctiveTurns returns the turn time, repo and hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-mine-'));
  const f = transcript(dir, 't.jsonl', [
    userTurn('S1', 'add a header', '2026-06-01T10:00:00.000Z', '/gone/away/myrepo'),
    userTurn('S1', 'no, only the header', '2026-06-01T10:05:00.000Z', '/gone/away/myrepo'),
    { type: 'user', sessionId: 'S1', message: { role: 'user', content: 'still broken' } },
  ]);
  assert.deepStrictEqual(mine.correctiveTurns(f), [
    { session_id: 'S1', text: 'no, only the header', repo: 'myrepo', h: store.hash('no, only the header'), ts: '2026-06-01T10:05:00.000Z' },
    { session_id: 'S1', text: 'still broken', repo: '', h: store.hash('still broken') },
  ]);
});

test('repoOf uses the git repo key for a subdirectory of a live repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-repo-'));
  require('node:child_process').execFileSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, 'src'));
  assert.strictEqual(mine.repoOf(path.join(root, 'src')), path.basename(fs.realpathSync(root)));
  assert.strictEqual(mine.repoOf(''), '');
});

test('session end queues corrections with their own time, repo and hash, and bumps with a source', () => {
  fresh();
  store.importRules([{ ...RULE, sources: [src('A', 0)] }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buc-end-'));
  const f = transcript(dir, 't.jsonl', [
    userTurn('S9', 'add a header', '2026-06-20T10:00:00.000Z', '/gone/away/myrepo'),
    userTurn('S9', 'no, only the header', '2026-06-20T10:05:00.000Z', '/gone/away/myrepo'),
  ]);
  withEnv({ BUC_NOW: '2026-06-21T00:00:00.000Z' }, () => assert.strictEqual(require('../hooks/session-end').run({ transcript_path: f }), 1));
  const h = store.hash('no, only the header');
  assert.deepStrictEqual(store.readInbox(), [{ ts: '2026-06-20T10:05:00.000Z', session_id: 'S9', text: 'no, only the header', repo: 'myrepo', h }]);
  const [r] = store.loadRules();
  assert.deepStrictEqual([r.count, r.last_seen], [2, '2026-06-21T00:00:00.000Z']);
  assert.deepStrictEqual(r.sources[1], { session: 'S9', repo: 'myrepo', ts: '2026-06-20T10:05:00.000Z', h, origin: 'bump' });
  assert.deepStrictEqual(store.asOf([r], { excludeSessions: ['S9'] })[0].count, 1);
});

test('feedback.onPrompt records hands-off evidence and queues corrections with hash and prompt time', () => {
  fresh();
  const feedback = require('../lib/rules/feedback');
  assert.strictEqual(feedback.onPrompt({ prompt: 'just show me how the nav works', sessionId: 's1', repo: 'r1' }), null);
  feedback.onPrompt({ prompt: 'make the nav sticky', sessionId: 's1', repo: 'r1' });
  feedback.onPrompt({ prompt: 'make the nav sticky', sessionId: 's1', repo: null });
  assert.deepStrictEqual(store.repoState('r1').events.map((e) => e.e), ['handsoff', 'edit']);
  store.saveLastTurn('s1', { rules: ['only-named'], repo: 'r1' });
  withEnv({ BUC_NOW: '2026-07-01T00:00:00.000Z' }, () => feedback.onPrompt({ prompt: 'no, that is not what I meant', sessionId: 's1', repo: 'r1' }));
  const [entry] = store.readInbox();
  assert.deepStrictEqual([entry.h, entry.ts, entry.repo], [store.hash('no, that is not what I meant'), '2026-07-01T00:00:00.000Z', 'r1']);
});

test('retrieve honours scope.repos', () => {
  const scoped = store.normalize({ ...RULE, pinned: true, when: { keywords: ['only'], promptKinds: ['edit'] }, scope: { repos: ['r1'] } }).rule;
  const ids = (repo) => retrieve({ prompt: 'add a chat panel', rules: [scoped], repo }).matched.map((r) => r.id);
  assert.deepStrictEqual([ids('r1'), ids('r2'), ids(undefined)], [['only-named'], [], []]);
  const { scope: _s, ...global } = scoped;
  assert.deepStrictEqual(retrieve({ prompt: 'add a chat panel', rules: [global], repo: 'r2' }).matched.length, 1);
  assert.strictEqual(matches(scoped, 'only this', 'edit', new Set(['only']), 'r2'), false);
  assert.strictEqual(matches(scoped, 'only this', 'edit', new Set(['only']), 'r1'), true);
});
