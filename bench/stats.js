#!/usr/bin/env node
'use strict';
// Statistics for bench results. See bench/README.md.

// Small seeded generator (mulberry32) so every interval is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A row's metric as a number: a key or a function; booleans count as 0 or 1, anything else is missing.
function value(row, metric) {
  const v = typeof metric === 'function' ? metric(row) : row[metric];
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// One paired difference per case: mean of the metric in arm A minus the mean in arm B.
// Cases missing either arm are left out, so reps never count as independent samples.
function caseDiffs(rows, armA, armB, metric) {
  const by = new Map();
  for (const r of rows) {
    if (r.arm !== armA && r.arm !== armB) continue;
    const v = value(r, metric);
    if (v === null) continue;
    if (!by.has(r.case)) by.set(r.case, { [armA]: [], [armB]: [] });
    by.get(r.case)[r.arm].push(v);
  }
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const out = [];
  for (const [c, g] of by) if (g[armA].length && g[armB].length) out.push({ case: c, diff: avg(g[armA]) - avg(g[armB]) });
  return out;
}

// Quantile of a sorted array, linear interpolation.
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Case-clustered paired bootstrap of mean(armA) - mean(armB): cases are resampled with replacement, runs are not.
// Returns the mean difference over cases and a percentile interval (90% by default).
function pairedBootstrap(rows, armA, armB, metric, { B = 10000, seed = 10, level = 0.9 } = {}) {
  const d = caseDiffs(rows, armA, armB, metric).map((x) => x.diff);
  const n = d.length;
  if (!n) return { diff: null, lo: null, hi: null, cases: 0, B, level, seed };
  const avg = d.reduce((a, b) => a + b, 0) / n;
  const next = rng(seed);
  const means = new Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(next() * n)];
    means[b] = s / n;
  }
  means.sort((x, y) => x - y);
  return { diff: avg, lo: quantile(means, (1 - level) / 2), hi: quantile(means, 1 - (1 - level) / 2), cases: n, B, level, seed };
}

const avg = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);

// One arm's headline numbers over its runs: counts of first-try and final passes, and per-run means.
function armSummary(rows, arm) {
  const mine = rows.filter((r) => r.arm === arm);
  const nums = (metric) => mine.map((r) => value(r, metric)).filter((v) => v !== null);
  const cost = nums('total_cost_usd');
  return {
    arm, runs: mine.length, cases: new Set(mine.map((r) => r.case)).size,
    first_try: mine.filter((r) => r.first_try_pass).length, final: mine.filter((r) => r.final_pass).length,
    interventions: avg(nums('interventions')), tokens_to_accept: avg(nums('tokens_to_accept')),
    cost: avg(cost), cost_total: cost.reduce((x, y) => x + y, 0),
  };
}

// CLI: node bench/stats.js <results.json> [--a buc] [--b plain] [--metric interventions] [--B 10000] [--seed 10]
function main(argv) {
  const f = { a: 'buc', b: 'plain', metric: 'interventions', B: '10000', seed: '10' };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) f[argv[i].slice(2)] = argv[++i];
    else files.push(argv[i]);
  }
  const rows = files.flatMap((p) => JSON.parse(require('node:fs').readFileSync(p, 'utf8')));
  const r = pairedBootstrap(rows, f.a, f.b, f.metric, { B: parseInt(f.B, 10), seed: parseInt(f.seed, 10) });
  console.log(JSON.stringify({ a: f.a, b: f.b, metric: f.metric, ...r }));
}

module.exports = { rng, value, caseDiffs, quantile, pairedBootstrap, armSummary };
if (require.main === module) main(process.argv.slice(2));
