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

// more tests below
