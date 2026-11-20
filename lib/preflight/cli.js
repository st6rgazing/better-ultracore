'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const report = require('./report');
const secrets = require('./secrets');
const { runBuild, checkNoSourceMaps } = require('./build');
const { runBrowser } = require('./browser');
const { evaluate } = require('./asvs');
const promote = require('./promote');

const OPTIONS = {
  dir: { type: 'string', default: '.' },
  base: { type: 'string' },
  head: { type: 'string', default: 'HEAD' },
  dist: { type: 'string', default: 'dist' },
  config: { type: 'string', default: 'buc.preflight.json' },
  out: { type: 'string', default: '.buc/preflight' },
  evidence: { type: 'string' },
  'skip-build': { type: 'boolean', default: false },
  'skip-browser': { type: 'boolean', default: false },
  sha: { type: 'string' },
  artifact: { type: 'string' },
  url: { type: 'string' },
  manifest: { type: 'string', default: 'promote-manifest.json' },
  verify: { type: 'boolean', default: false },
};

function loadConfig(dir, file) {
  const p = path.resolve(dir, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function preflight(v) {
  const dir = path.resolve(v.dir);
  const config = loadConfig(dir, v.config);
  const distDir = path.resolve(dir, v.dist);
  const req = id => (config.required && id in config.required ? config.required[id] : true);
  const mk = (id, r) => report.check(id, r.status, r.detail, req(id));
  const skipped = id => mk(id, { status: 'unverified', detail: 'skipped by flag' });

  const checks = [];
  const s = secrets.run({ dir, distDir, base: v.base, head: v.head, config: config.secrets });
  checks.push({ ...mk('secrets', s), findings: s.findings });
  checks.push(v['skip-build'] ? skipped('build') : mk('build', runBuild(dir, config.build && config.build.cmd)));
  checks.push(mk('dist-no-sourcemaps', checkNoSourceMaps(distDir, config.build && config.build.allowMaps)));
  checks.push(v['skip-browser'] ? skipped('browser') : mk('browser', runBrowser(dir, config.browser && config.browser.cmd)));
  checks.push(...evaluate(dir, config.asvs || [], { evidence: v.evidence }));
  return checks;
}

async function promoteCmd(v) {
  if (v.verify) {
    const r = await promote.verify(v.manifest, { artifact: v.artifact, url: v.url });
    console.log(`promote: ${r.status} (${r.detail})`);
    return r.status === 'passed' ? 0 : 1;
  }
  if (!v.sha || !v.artifact) {
    console.error('promote needs --sha and --artifact');
    return 1;
  }
  promote.writeManifest(v.manifest, { sha: v.sha, artifact: v.artifact });
  console.log(`promote: manifest written to ${v.manifest}`);
  return 0;
}

// argv excludes the node binary and script; a leading "preflight" is accepted.
async function run(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const words = positionals[0] === 'preflight' ? positionals.slice(1) : positionals;
  if (words[0] === 'promote') return promoteCmd(values);
  const checks = preflight(values);
  const out = report.write(path.resolve(values.out), checks);
  for (const c of checks) console.log(`${c.id}: ${c.status}${c.required ? '' : ' (optional)'}`);
  console.log(`report: ${path.join(values.out, 'preflight.md')}`);
  return out.exitCode;
}

module.exports = { run };
