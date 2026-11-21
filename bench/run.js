#!/usr/bin/env node
'use strict';
// 4-arm benchmark harness. See bench/README.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { simulate } = require('./sim-user');

const ROOT = path.join(__dirname, '..');
const CASES_DIR = path.join(__dirname, 'cases');
const PRIVATE_DIR = path.join(__dirname, 'private');
const RULES = path.join(__dirname, 'fixtures', 'rules.json');
const ALLOWED_TOOLS = 'Bash(node:*),Bash(npm:*),Bash(git:*),Agent,Workflow,Read,Edit,Write,Grep,Glob';

// ultra = stock Ultracode: no plugin, prompt unchanged, advisory settings plus xhigh effort.
const ARMS = {
  plain: { noPlugin: true, budgetMult: 1, extra: [] },
  'plain-claudemd': { noPlugin: true, budgetMult: 1, claudeMd: true, extra: [] },
  buc: { noPlugin: false, budgetMult: 1, bucHome: true, extra: [] },
  ultra: { noPlugin: true, budgetMult: 2, extra: ['--settings', '{"ultracode":true,"workflowSizeGuideline":"small"}', '--effort', 'xhigh'] },
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

// Case names from bench/cases and (when present) bench/private; public wins on a name clash.
function listCases() {
  const out = new Map();
  for (const root of [PRIVATE_DIR, CASES_DIR]) {
    if (!fs.existsSync(root)) continue;
    for (const c of fs.readdirSync(root)) if (fs.existsSync(path.join(root, c, 'setup.sh'))) out.set(c, path.join(root, c));
  }
  return out;
}
const caseDirs = listCases();
const caseDir = (c) => caseDirs.get(c);
const read = (c, f) => fs.readFileSync(path.join(caseDir(c), f), 'utf8').trim();
const has = (c, f) => fs.existsSync(path.join(caseDir(c), f));

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

// Spawns claude directly (BUC_CLAUDE_BIN honoured) so session_id is available for resumes. Same JSON shape as buc run-headless plus session_id.
function claudeCall(prompt, { arm, budget, timeoutMin, cwd, env, resume }) {
  const a = ARMS[arm];
  const args = ['-p', prompt, '--output-format', 'json', '--model', 'sonnet', '--max-budget-usd', String(budget * a.budgetMult),
    '--permission-mode', 'acceptEdits', '--allowedTools', ...ALLOWED_TOOLS.split(',')];
  if (!a.noPlugin) args.push('--plugin-dir', ROOT);
  if (resume) args.push('--resume', resume);
  args.push(...a.extra);
  const started = Date.now();
  const p = spawnSync(process.env.BUC_CLAUDE_BIN || 'claude', args, { encoding: 'utf8', maxBuffer: 1 << 28, cwd, env, timeout: timeoutMin * 60000, killSignal: 'SIGTERM' });
  let r;
  try { r = JSON.parse((p.stdout || '').trim()); } catch { r = { result: (p.stdout || '').trim() || (p.stderr || '').slice(0, 500) || null }; }
  return {
    exit: p.status ?? p.signal, timed_out: !!(p.error && p.error.code === 'ETIMEDOUT'), elapsed_ms: Date.now() - started,
    session_id: r.session_id || null, total_cost_usd: r.total_cost_usd ?? null, usage: r.usage ?? null, num_turns: r.num_turns ?? null,
    subagent_stats: r.subagent_stats ?? null, model_usage: r.modelUsage ?? null, result: r.result ?? null,
  };
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

// Did Ultracode actually engage? Looks for its effort marker in any transcript of the run.
function ultraActive(dir) {
  const proj = path.join(os.homedir(), '.claude', 'projects', fs.realpathSync(dir).replace(/[^a-zA-Z0-9]/g, '-'));
  if (!fs.existsSync(proj)) return false;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).some((e) => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) return walk(f);
    return f.endsWith('.jsonl') && fs.readFileSync(f, 'utf8').includes('ultra_effort_enter');
  });
  return walk(proj);
}

// The run's patch against HEAD as setup.sh left it, untracked files included.
// Files left untracked by setup.sh (e.g. a fixture .env) are not part of the run's patch.
function patchOf(dir, preUntracked = [], base) {
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout || '';
  const root = base || git('rev-list', '--max-parents=0', 'HEAD').trim().split('\n')[0];
  const fresh = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter((f) => f && !preUntracked.includes(f));
  if (fresh.length) git('add', '-N', '--', ...fresh);
  const stat = git('diff', '--numstat', root).trim().split('\n').filter(Boolean)
    .map((l) => { const [a, d, f] = l.split('\t'); return { file: f, added: +a || 0, deleted: +d || 0 }; });
  const patch = git('diff', root).slice(0, 20000);
  // Drop the intent-to-add entries again so a mid-run snapshot leaves the index as the agent left it.
  if (fresh.length) git('reset', '-q', '--', ...fresh);
  return { root, stat, patch };
}

// Audit entry for one agent call: what the user said, what came back, and the repo state right after it.
// pass is null when accept was not run after this call; the patch is cumulative since setup.
function roundEntry(round, prompt, run, pass, diff) {
  const reply = typeof run.result === 'string' ? run.result : null;
  return {
    round, prompt: String(prompt || '').slice(0, 400),
    reply_excerpt: reply === null ? null : reply.slice(0, 600),
    reply_tail: reply !== null && reply.length > 600 ? reply.slice(-300) : null,
    accept_pass: pass,
    files_changed: diff.stat.map((x) => x.file),
    lines_changed: diff.stat.reduce((n, x) => n + x.added + x.deleted, 0),
    patch: diff.patch,
    exit: run.exit ?? null, timed_out: !!run.timed_out, total_cost_usd: run.total_cost_usd ?? null,
  };
}

// Control arm: the same rules as static bullets. Excluded via .git/info/exclude so the file is not part of the patch.
// Uses the same rules the buc arm gets (--buc-home), appended so a repo's own CLAUDE.md is kept.
function writeClaudeMd(dir, bucHome) {
  const src = bucHome && fs.existsSync(path.join(bucHome, 'rules.json')) ? path.join(bucHome, 'rules.json') : RULES;
  const rules = JSON.parse(fs.readFileSync(src, 'utf8'));
  const file = path.join(dir, 'CLAUDE.md');
  const tracked = spawnSync('git', ['-C', dir, 'ls-files', '--error-unmatch', 'CLAUDE.md']).status === 0;
  fs.appendFileSync(file, `\n# Rules\n\n${rules.map((r) => `- ${r.rule}`).join('\n')}\n`);
  if (tracked) spawnSync('git', ['-C', dir, 'update-index', '--assume-unchanged', 'CLAUDE.md']);
  else fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'CLAUDE.md\n');
}

function liveRun(c, arm, rep, o) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${c}-${arm}-`));
  const dir = path.join(parent, 'work');
  try {
    const s = sh(path.join(caseDir(c), 'setup.sh'), dir);
    if (s.status !== 0) throw new Error(`setup failed for ${c}: ${s.stderr}`);
    if (ARMS[arm].claudeMd) writeClaudeMd(dir, o.bucHome);
    // Each buc run gets its own copy of the seeded rules so runs never share learned state.
    const env = { ...process.env };
    if (ARMS[arm].bucHome) {
      env.BUC_HOME = path.join(parent, 'buc-home');
      if (o.bucHome) fs.cpSync(o.bucHome, env.BUC_HOME, { recursive: true }); else fs.mkdirSync(env.BUC_HOME);
    }
    const prompt = read(c, 'prompt.txt');
    const base = (spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim();
    const preUntracked = (spawnSync('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).stdout || '').split('\0').filter(Boolean);
    const call = (p, extra = {}) => claudeCall(p, { arm, budget: o.budget, timeoutMin: o.timeoutMin, cwd: dir, env, ...extra });
    const runs = [];
    let corrections = 0;
    if (has(c, 'correction.txt')) {
      runs.push(call(prompt, { timeoutMin: o.timeoutMin / 3 }));
      runs.push(call(`${read(c, 'correction.txt')}\nOriginal task: ${prompt}`));
      corrections = 1;
    } else {
      runs.push(call(prompt));
    }
    // Final reply lands outside the repo so read-only cases can be accepted on what was said.
    const accept = () => {
      const last = runs[runs.length - 1];
      fs.writeFileSync(path.join(parent, 'result.txt'), typeof last.result === 'string' ? last.result : '');
      return sh(path.join(caseDir(c), 'accept.sh'), dir).status === 0;
    };
    const sid = () => [...runs].reverse().map((r) => r.session_id).find(Boolean);
    const sim = simulate({
      first: runs[runs.length - 1],
      accept,
      followup: has(c, 'followup.txt') ? read(c, 'followup.txt') : null,
      resume: (reply) => { const r = call(reply, { resume: sid() }); runs.push(r); return r; },
    });
    const interventions = corrections + sim.interventions;
    const last = runs[runs.length - 1];
    const sum = (f) => runs.reduce((n, r) => n + (f(r) || 0), 0);
    const tok = runs.map((r) => sumTokens(r.model_usage, r.usage));
    const diff = patchOf(dir, preUntracked, base);
    return {
      case: c, arm, rep,
      accept_pass: sim.final_pass,
      first_try_pass: sim.first_try_pass && !corrections,
      final_pass: sim.final_pass,
      ultra_active: arm === 'ultra' ? ultraActive(dir) : null,
      transcript_tokens: transcriptTokens(dir),
      files_changed: diff.stat.map((x) => x.file),
      lines_changed: diff.stat.reduce((n, x) => n + x.added + x.deleted, 0),
      patch: diff.patch,
      exit: last.exit, timed_out: !!last.timed_out,
      elapsed_ms: sum((r) => r.elapsed_ms),
      total_cost_usd: sum((r) => r.total_cost_usd),
      tokens: { input: tok.reduce((n, t) => n + t.input, 0), output: tok.reduce((n, t) => n + t.output, 0) },
      tokens_to_accept: tok.reduce((n, t) => n + t.input + t.output, 0),
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
    sh(path.join(caseDir(c), 'setup.sh'), dir);
    const unsolved = sh(path.join(caseDir(c), 'accept.sh'), dir).status;
    const hasSolve = fs.existsSync(path.join(caseDir(c), 'solve.sh'));
    if (hasSolve) sh(path.join(caseDir(c), 'solve.sh'), dir);
    const solved = hasSolve ? sh(path.join(caseDir(c), 'accept.sh'), dir).status : null;
    return { case: c, unsolved_fails: unsolved !== 0, solved_passes: hasSolve ? solved === 0 : null };
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
  const out = ['| case | arm | n | first-try rate | final pass rate | mean cost USD | mean tokens to accept | mean elapsed s | mean turns | mean subagents | mean interventions |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const [k, g] of groups) {
    const [c, arm] = k.split('|');
    out.push(`| ${c} | ${arm} | ${g.length} | ${fmt(100 * g.filter((r) => r.first_try_pass).length / g.length)}% | ${fmt(100 * g.filter((r) => r.final_pass).length / g.length)}% | ${fmt(mean(g.map((r) => r.total_cost_usd)), 3)} | ${fmt(mean(g.map((r) => r.tokens_to_accept)))} | ${fmt(mean(g.map((r) => r.elapsed_ms / 1000)), 1)} | ${fmt(mean(g.map((r) => r.num_turns)), 1)} | ${fmt(mean(g.map((r) => r.subagents)), 1)} | ${fmt(mean(g.map((r) => r.interventions)), 1)} |`);
  }
  return out.join('\n');
}

function main(argv) {
  const f = parseArgs(argv);
  const all = [...caseDirs.keys()].sort();
  const cases = f.cases ? f.cases.split(',') : all;
  for (const c of cases) if (!all.includes(c)) throw new Error(`unknown case: ${c}`);
  if (f.dry) {
    console.log(`arms: ${Object.keys(ARMS).join(', ')}`);
    const res = cases.map(dryRun);
    for (const r of res) console.log(`${r.case}: unsolved fails=${r.unsolved_fails} solved passes=${r.solved_passes === null ? 'n/a (no solve.sh)' : r.solved_passes}`);
    process.exitCode = res.every((r) => r.unsolved_fails && r.solved_passes !== false) ? 0 : 1;
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

module.exports = { sumTokens, table, parseArgs, ARMS, listCases, roundEntry, patchOf };
if (require.main === module) main(process.argv.slice(2));
