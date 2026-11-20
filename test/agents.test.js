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

test('exactly worker and critic exist with required frontmatter', () => {
  assert.deepStrictEqual(Object.keys(agents).sort(), ['critic', 'worker']);
  for (const [name, a] of Object.entries(agents)) {
    assert.strictEqual(a.name, name);
    for (const k of ['description', 'model', 'tools', 'maxTurns']) assert.ok(a[k], `${name}.${k}`);
  }
});

test('critic has no Edit or Write but can run Bash', () => {
  assert.ok(!tools('critic').includes('Edit') && !tools('critic').includes('Write'));
  assert.ok(tools('critic').includes('Bash'));
});

test('worker can edit; both agents use sonnet', () => {
  for (const t of ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']) assert.ok(tools('worker').includes(t), t);
  assert.deepStrictEqual(Object.values(agents).map((a) => a.model), ['sonnet', 'sonnet']);
});

const engine = fs.readFileSync(path.join(ROOT, 'lib', 'engine.js'), 'utf8');

test('engine: every agent( call site passes model', () => {
  const sites = [...engine.matchAll(/\bagent\(/g)];
  assert.ok(sites.length >= 1);
  for (const m of sites) assert.match(engine.slice(m.index, m.index + 200), /model:/);
});

test('engine: every launch( call site supplies a model', () => {
  const sites = [...engine.matchAll(/\blaunch\((?!label)/g)];
  assert.ok(sites.length >= 2);
  for (const m of sites) assert.match(engine.slice(m.index, m.index + 600), /model: '/);
});

test('engine: agentType values reference existing agents', () => {
  for (const m of engine.matchAll(/agentType: 'better-ultracore:([\w-]+)'/g)) assert.ok(agents[m[1]], m[1]);
});
