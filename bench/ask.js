'use strict';
// Offline model calls for bench tooling (replay clustering, eval pre-labels): cached on disk and capped in USD.
// Nothing here runs in a hook. The cache dir must be outside the repo: prompts carry private text.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SYSTEM = 'You are a careful labelling tool. Reply with JSON only: no prose, no code fences.';

// Refuses a cache dir inside this repo, so cached prompts and replies can never be committed by accident.
function outside(dir) {
  const repo = path.join(__dirname, '..');
  const rel = path.relative(fs.existsSync(repo) ? fs.realpathSync(repo) : repo, path.resolve(dir));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`cache dir must be outside the repo: ${dir}`);
  return path.resolve(dir);
}

// USD spent so far under one label, from <cacheDir>/spend.json ({label: {total, calls}}).
function spent(cacheDir, label) {
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir, 'spend.json'), 'utf8'))[label].total || 0; } catch { return 0; }
}

// Adds one call's cost to the ledger and returns the new total for the label.
function charge(cacheDir, label, cost) {
  const file = path.join(cacheDir, 'spend.json');
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first call */ }
  const cur = all[label] || { total: 0, calls: 0 };
  all[label] = { total: cur.total + (Number(cost) || 0), calls: cur.calls + 1 };
  fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
  return all[label].total;
}

// The first JSON value in a model reply, tolerating a code fence or a sentence around it; null when there is none.
function jsonIn(text) {
  const s = String(text || '');
  const at = (ch) => (s.indexOf(ch) < 0 ? Infinity : s.indexOf(ch));
  for (const [open, close] of [['[', ']'], ['{', '}']].sort((x, y) => at(x[0]) - at(y[0]))) {
    const a = s.indexOf(open);
    const b = s.lastIndexOf(close);
    if (a < 0 || b <= a) continue;
    try { return JSON.parse(s.slice(a, b + 1)); } catch { /* try the other bracket */ }
  }
  return null;
}

// One `claude -p` call with no tools, cached by model and prompt. Returns {text, cost, cached}.
// opts: cacheDir (required, outside the repo), label and cap (USD budget shared by every call with that label),
// model (haiku by default), bin (BUC_CLAUDE_BIN or claude). Throws with code 'BUDGET' once the cap is reached,
// before spending; a cached answer is always free.
function ask(prompt, { cacheDir, label = 'ask', cap = 1, model = 'haiku', bin = process.env.BUC_CLAUDE_BIN || 'claude', timeoutMs = 240000 } = {}) {
  const dir = outside(cacheDir);
  const key = crypto.createHash('sha1').update(`${model}\n${prompt}`).digest('hex');
  const file = path.join(dir, 'answers', `${key}.json`);
  if (fs.existsSync(file)) return { ...JSON.parse(fs.readFileSync(file, 'utf8')), cost: 0, cached: true };
  const left = cap - spent(dir, label);
  if (left <= 0.01) throw Object.assign(new Error(`${label}: budget of $${cap} reached`), { code: 'BUDGET' });
  // Runs in its own empty folder with a throwaway BUC_HOME, so an installed copy of this plugin learns nothing from it.
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['-p', '--model', model, '--output-format', 'json', '--max-budget-usd', left.toFixed(2), '--tools', '',
    '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--system-prompt', SYSTEM];
  const p = spawnSync(bin, args, { input: prompt, encoding: 'utf8', maxBuffer: 1 << 26, cwd, timeout: timeoutMs, env: { ...process.env, BUC_HOME: path.join(dir, 'unused-buc-home') } });
  let r = null;
  try { r = JSON.parse((p.stdout || '').trim()); } catch { /* not JSON */ }
  const cost = r && typeof r.total_cost_usd === 'number' ? r.total_cost_usd : 0;
  if (cost) charge(dir, label, cost);
  if (!r || typeof r.result !== 'string' || r.is_error) throw new Error(`${label}: model call failed: ${(r && r.result) || (p.stderr || '').slice(0, 300) || p.status}`);
  fs.writeFileSync(file, JSON.stringify({ text: r.result, model }));
  return { text: r.result, model, cost, cached: false };
}

module.exports = { ask, jsonIn, spent, charge, outside, SYSTEM };
