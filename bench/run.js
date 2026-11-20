#!/usr/bin/env node
'use strict';
// 4-arm benchmark harness. See bench/README.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CASES_DIR = path.join(__dirname, 'cases');
const RULES = path.join(__dirname, 'fixtures', 'rules.json');
const ALLOWED_TOOLS = 'Bash(node:*),Bash(npm:*),Bash(git:*),Agent,Workflow,Read,Edit,Write,Grep,Glob';

const ARMS = {
  plain: { noPlugin: true, prefix: '', budgetMult: 1 },
  'plain-claudemd': { noPlugin: true, prefix: '', budgetMult: 1, claudeMd: true },
  buc: { noPlugin: false, prefix: '', budgetMult: 1, bucHome: true },
  ultra: { noPlugin: true, prefix: 'ultracode ', budgetMult: 2 },
};

function parseArgs(argv) {
  const f = { arms: 'plain,plain-claudemd,buc,ultra', n: '1', budget: '1', 'timeout-min': '10' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    f[k] = k === 'dry' ? true : argv[++i];
  }
  return f;
}

const sh = (script, dir) => spawnSync('sh', [script, dir], { encoding: 'utf8' });
const read = (c, f) => fs.readFileSync(path.join(CASES_DIR, c, f), 'utf8').trim();

// Sum tokens across models: input includes cache read + creation.
function sumTokens(modelUsage, usage) {
  const t = { input: 0, output: 0 };
  const rows = modelUsage ? Object.values(modelUsage) : [];
  if (rows.length) {
    for (const m of rows) {
      t.input += (m.inputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0);
      t.output += m.outputTokens || 0;
    }
  } else if (usage) {
    t.input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    t.output = usage.output_tokens || 0;
  }
  return t;
}

function headless(prompt, { arm, budget, timeoutMin, cwd, env }) {
  const a = ARMS[arm];
  const args = [path.join(ROOT, 'bin', 'buc'), 'run-headless', '--cwd', cwd, '--prompt', a.prefix + prompt,
    '--model', 'sonnet', '--max-budget-usd', String(budget * a.budgetMult), '--timeout-min', String(timeoutMin),
    '--allowed-tools', ALLOWED_TOOLS];
  if (a.noPlugin) args.push('--no-plugin'); else args.push('--plugin-dir', ROOT);
  const p = spawnSync('node', args, { encoding: 'utf8', maxBuffer: 1 << 28, cwd: ROOT, env });
  const line = (p.stdout || '').trim().split('\n').pop();
  try { return JSON.parse(line); } catch { return { exit: p.status, timed_out: false, elapsed_ms: 0, result: (p.stderr || '').slice(0, 500) }; }
}

// Independent token count: every transcript the run wrote (main loop, subagents, workflow agents), deduped by message id.
function transcriptTokens(dir) {
  const slug = fs.realpathSync(dir).replace(/[^a-zA-Z0-9]/g, '-');
  const proj = path.join(os.homedir(), '.claude', 'projects', slug);
  const t = { input: 0, output: 0, files: 0 };
  if (!fs.existsSync(proj)) return null;
  const seen = new Set();
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) return walk(f);
    if (!f.endsWith('.jsonl')) return;
    t.files++;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      const m = o && o.message;
      if (!m || !m.usage || o.type !== 'assistant') continue;
      const key = `${f}|${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      t.input += (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
      t.output += m.usage.output_tokens || 0;
    }
  });
  walk(proj);
  return t;
}

// The run's patch against the fixture's first commit, untracked files included.
// Files left untracked by setup.sh (e.g. a fixture .env) are not part of the run's patch.
function patchOf(dir, preUntracked = []) {
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout || '';
  const root = git('rev-list', '--max-parents=0', 'HEAD').trim().split('\n')[0];
  const fresh = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter((f) => f && !preUntracked.includes(f));
  if (fresh.length) git('add', '-N', '--', ...fresh);
  const stat = git('diff', '--numstat', root).trim().split('\n').filter(Boolean)
    .map((l) => { const [a, d, f] = l.split('\t'); return { file: f, added: +a || 0, deleted: +d || 0 }; });
  return { root, stat, patch: git('diff', root).slice(0, 20000) };
}

// Control arm: the same rules as static bullets. Excluded via .git/info/exclude so the file is not part of the patch.
function writeClaudeMd(dir) {
  const rules = JSON.parse(fs.readFileSync(RULES, 'utf8'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Rules\n\n${rules.map((r) => `- ${r.rule}`).join('\n')}\n`);
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'CLAUDE.md\n');
}

function liveRun(c, arm, rep, o) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${c}-${arm}-`));
  const dir = path.join(parent, 'work');
  try {
    const s = sh(path.join(CASES_DIR, c, 'setup.sh'), dir);
    if (s.status !== 0) throw new Error(`setup failed for ${c}: ${s.stderr}`);
    if (ARMS[arm].claudeMd) writeClaudeMd(dir);
    // Each buc run gets its own copy of the seeded rules so runs never share learned state.
    const env = { ...process.env };
    if (ARMS[arm].bucHome) {
      env.BUC_HOME = path.join(parent, 'buc-home');
      if (o.bucHome) fs.cpSync(o.bucHome, env.BUC_HOME, { recursive: true }); else fs.mkdirSync(env.BUC_HOME);
    }
    const prompt = read(c, 'prompt.txt');
    const preUntracked = (spawnSync('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).stdout || '').split('\0').filter(Boolean);
    const runs = [];
    let interventions = 0;
    if (fs.existsSync(path.join(CASES_DIR, c, 'correction.txt'))) {
      runs.push(headless(prompt, { arm, budget: o.budget, timeoutMin: o.timeoutMin / 3, cwd: dir, env }));
      runs.push(headless(`${read(c, 'correction.txt')}\nOriginal task: ${prompt}`, { arm, budget: o.budget, timeoutMin: o.timeoutMin, cwd: dir, env }));
      interventions = 1;
    } else {
      runs.push(headless(prompt, { arm, budget: o.budget, timeoutMin: o.timeoutMin, cwd: dir, env }));
    }
    const last = runs[runs.length - 1];
    // A run that stops to ask the user (a question near the end, or an explicit "which do you mean") needs a human.
    if (typeof last.result === 'string' && (/\?\s*$/.test(last.result.trim()) || /\b(which (of these|one) do you (mean|want)|do you want me to|should i)\b[^.]*\?/i.test(last.result))) interventions += 1;
    const sum = (f) => runs.reduce((n, r) => n + (f(r) || 0), 0);
    const tok = runs.map((r) => sumTokens(r.model_usage, r.usage));
    // Final reply lands outside the repo so read-only cases can be accepted on what was said.
    fs.writeFileSync(path.join(parent, 'result.txt'), typeof last.result === 'string' ? last.result : '');
    const accept = sh(path.join(CASES_DIR, c, 'accept.sh'), dir).status === 0;
    const diff = patchOf(dir, preUntracked);
    return {
      case: c, arm, rep,
      accept_pass: accept,
      transcript_tokens: transcriptTokens(dir),
      files_changed: diff.stat.map((x) => x.file),
      lines_changed: diff.stat.reduce((n, x) => n + x.added + x.deleted, 0),
      patch: diff.patch,
      exit: last.exit, timed_out: !!last.timed_out,
      elapsed_ms: sum((r) => r.elapsed_ms),
      total_cost_usd: sum((r) => r.total_cost_usd),
      tokens: { input: tok.reduce((n, t) => n + t.input, 0), output: tok.reduce((n, t) => n + t.output, 0) },
      num_turns: sum((r) => r.num_turns),
      subagents: sum((r) => r.subagent_stats && r.subagent_stats.spawned),
      interventions,
      result_excerpt: typeof last.result === "string" ? last.result.slice(0, 600) : null,
      source: 'live',
    };
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}

function dryRun(c) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `bench-dry-${c}-`));
  const dir = path.join(parent, 'work');
  try {
    sh(path.join(CASES_DIR, c, 'setup.sh'), dir);
    const unsolved = sh(path.join(CASES_DIR, c, 'accept.sh'), dir).status;
    const hasSolve = fs.existsSync(path.join(CASES_DIR, c, 'solve.sh'));
    if (hasSolve) sh(path.join(CASES_DIR, c, 'solve.sh'), dir);
    const solved = hasSolve ? sh(path.join(CASES_DIR, c, 'accept.sh'), dir).status : null;
    return { case: c, unsolved_fails: unsolved !== 0, solved_passes: solved === 0 };
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}

const mean = (xs) => { const v = xs.filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const fmt = (x, d = 0) => (x === null ? '-' : x.toFixed(d));

function table(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.case}|${r.arm}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = ['| case | arm | n | pass rate | mean cost USD | mean tokens | mean elapsed s | mean turns | mean subagents | mean interventions |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const [k, g] of groups) {
    const [c, arm] = k.split('|');
    out.push(`| ${c} | ${arm} | ${g.length} | ${fmt(100 * g.filter((r) => r.accept_pass).length / g.length)}% | ${fmt(mean(g.map((r) => r.total_cost_usd)), 3)} | ${fmt(mean(g.map((r) => r.tokens.input + r.tokens.output)))} | ${fmt(mean(g.map((r) => r.elapsed_ms / 1000)), 1)} | ${fmt(mean(g.map((r) => r.num_turns)), 1)} | ${fmt(mean(g.map((r) => r.subagents)), 1)} | ${fmt(mean(g.map((r) => r.interventions)), 1)} |`);
  }
  return out.join('\n');
}

function main(argv) {
  const f = parseArgs(argv);
  const all = fs.readdirSync(CASES_DIR).filter((c) => fs.existsSync(path.join(CASES_DIR, c, 'setup.sh'))).sort();
  const cases = f.cases ? f.cases.split(',') : all;
  for (const c of cases) if (!all.includes(c)) throw new Error(`unknown case: ${c}`);
  if (f.dry) {
    const res = cases.map(dryRun);
    for (const r of res) console.log(`${r.case}: unsolved fails=${r.unsolved_fails} solved passes=${r.solved_passes}`);
    process.exitCode = res.every((r) => r.unsolved_fails && r.solved_passes) ? 0 : 1;
    return;
  }
  const arms = f.arms.split(',');
  for (const a of arms) if (!ARMS[a]) throw new Error(`unknown arm: ${a}`);
  const o = { budget: parseFloat(f.budget), timeoutMin: parseFloat(f['timeout-min']), bucHome: f['buc-home'] && path.resolve(f['buc-home']) };
  const rows = [];
  for (const c of cases) for (const arm of arms) for (let rep = 1; rep <= parseInt(f.n, 10); rep++) {
    console.error(`run ${c} ${arm} #${rep}`);
    rows.push(liveRun(c, arm, rep, o));
  }
  const out = f.out || path.join(__dirname, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log(table(rows));
  console.error(`wrote ${out}`);
}

module.exports = { sumTokens, table, parseArgs, ARMS };
if (require.main === module) main(process.argv.slice(2));
