'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const dir = path.join(ROOT, 'agents');

function frontmatter(file) {
  const m = fs.readFileSync(path.join(dir, file), 'utf8').match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, `${file} has frontmatter`);
  return Object.fromEntries(m[1].split('\n').map((l) => l.split(/:\s*/, 2)).map(([k, v]) => [k, v]));
}

const agents = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => [f.slice(0, -3), frontmatter(f)]));
const tools = (name) => agents[name].tools.split(/,\s*/);

test('all five agents exist with required frontmatter', () => {
  assert.deepStrictEqual(Object.keys(agents).sort(), ['coder', 'extractor', 'planner', 'reviewer-ro', 'verifier']);
  for (const [name, a] of Object.entries(agents)) {
    assert.strictEqual(a.name, name);
    for (const k of ['description', 'model', 'tools', 'maxTurns']) assert.ok(a[k], `${name}.${k}`);
  }
});

test('reviewer-ro has no Bash, Edit or Write', () => {
  for (const t of ['Bash', 'Edit', 'Write']) assert.ok(!tools('reviewer-ro').includes(t), t);
});

test('verifier has no Edit or Write but can run Bash', () => {
  assert.ok(!tools('verifier').includes('Edit') && !tools('verifier').includes('Write'));
  assert.ok(tools('verifier').includes('Bash'));
});

test('planner and extractor are read-only', () => {
  for (const n of ['planner', 'extractor']) assert.ok(!tools(n).some((t) => ['Bash', 'Edit', 'Write'].includes(t)), n);
});

test('models match the plan', () => {
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(agents).map(([n, a]) => [n, a.model])),
    { coder: 'sonnet', planner: 'fable', verifier: 'sonnet', 'reviewer-ro': 'sonnet', extractor: 'haiku' },
  );
});

const engine = fs.readFileSync(path.join(ROOT, 'lib', 'engine.js'), 'utf8');

test('engine: every agent( call site passes model', () => {
  const sites = [...engine.matchAll(/\bagent\(/g)];
  assert.ok(sites.length >= 1);
  for (const m of sites) assert.match(engine.slice(m.index, m.index + 200), /model:/);
});

test('engine: every launch( call site supplies a model', () => {
  const sites = [...engine.matchAll(/\blaunch\((?!label|id)/g)];
  assert.ok(sites.length >= 4);
  for (const m of sites) assert.match(engine.slice(m.index, m.index + 400), /model: '|coder\(/);
});

test('engine: agentType values reference existing agents', () => {
  for (const m of engine.matchAll(/agentType: 'better-ultracore:([\w-]+)'/g)) assert.ok(agents[m[1]], m[1]);
});
