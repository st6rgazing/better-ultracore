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

// Cases where arm A trails arm B on first-try passes by the pre-registered margin: 2 of 3 runs, 3 of 5 (60% of
// the runs both arms have, never fewer than 2). Returns [{case, a, b, runs}].
function behindCases(rows, armA, armB) {
  const by = new Map();
  for (const r of rows) {
    if (r.arm !== armA && r.arm !== armB) continue;
    if (!by.has(r.case)) by.set(r.case, { [armA]: [], [armB]: [] });
    by.get(r.case)[r.arm].push(r.first_try_pass ? 1 : 0);
  }
  const out = [];
  for (const [c, g] of by) {
    const n = Math.min(g[armA].length, g[armB].length);
    if (!n) continue;
    const a = g[armA].slice(0, n).reduce((x, y) => x + y, 0);
    const b = g[armB].slice(0, n).reduce((x, y) => x + y, 0);
    if (b - a >= Math.max(2, Math.ceil(0.6 * n))) out.push({ case: c, a, b, runs: n });
  }
  return out;
}

// The six pre-registered criteria (design section C), arm A (buc) against arm B (plain).
// rows: held-out runs made with --rules-as-of case. regression: arm A runs on the old real-task cases.
// Only cases with both arms count. Each result is {id, name, pass, detail}; pass is null when there is no data to judge.
function criteria(rows, { a = 'buc', b = 'plain', regression = [], B = 10000, seed = 10 } = {}) {
  const paired = new Set(caseDiffs(rows, a, b, () => 1).map((d) => d.case));
  const held = rows.filter((r) => paired.has(r.case) && (r.arm === a || r.arm === b));
  const sa = armSummary(held, a);
  const sb = armSummary(held, b);
  const none = held.length === 0;
  const out = [];
  const boot = pairedBootstrap(held, a, b, 'interventions', { B, seed });
  out.push({
    id: 1, name: 'interventions per run lower, 90% CI excludes 0',
    pass: none ? null : boot.diff < 0 && boot.hi < 0,
    detail: none ? 'no paired cases' : `diff ${boot.diff.toFixed(3)} [${boot.lo.toFixed(3)}, ${boot.hi.toFixed(3)}] over ${boot.cases} cases`,
  });
  // Compared as per-case rates, so an arm with more reps of a case does not count more passes.
  const first = caseDiffs(held, a, b, 'first_try_pass').reduce((n, d) => n + d.diff, 0);
  out.push({ id: 2, name: 'first-try count not lower', pass: none ? null : first >= -1e-9, detail: none ? 'no paired cases' : `${a} ${sa.first_try}/${sa.runs}, ${b} ${sb.first_try}/${sb.runs}` });
  const ratio = sa.tokens_to_accept !== null && sb.tokens_to_accept ? sa.tokens_to_accept / sb.tokens_to_accept : null;
  out.push({ id: 3, name: 'mean tokens to accept at most 1.05x', pass: ratio === null ? null : ratio <= 1.05, detail: ratio === null ? 'no token data' : `${ratio.toFixed(3)}x (${Math.round(sa.tokens_to_accept)} vs ${Math.round(sb.tokens_to_accept)})` });
  const behind = behindCases(held, a, b);
  out.push({ id: 4, name: 'no case behind by 2 of 3 (3 of 5) first-try passes', pass: none ? null : behind.length === 0, detail: none ? 'no paired cases' : behind.length ? behind.map((x) => `${x.case} ${x.a} vs ${x.b} of ${x.runs}`).join('; ') : 'none behind' });
  const controls = held.filter((r) => r.control === true);
  const ca = armSummary(controls, a);
  const cb = armSummary(controls, b);
  const cdiff = caseDiffs(controls, a, b, 'first_try_pass').reduce((n, d) => n + d.diff, 0);
  out.push({ id: 5, name: 'clean controls: first try at least equal', pass: controls.length ? cdiff >= -1e-9 : null, detail: controls.length ? `${a} ${ca.first_try}/${ca.runs}, ${b} ${cb.first_try}/${cb.runs}` : 'no control runs' });
  const old = armSummary(regression, a);
  // Pre-registered for 24 runs (8 cases, 3 reps): 12 first try and 22 final. Another run count scales both.
  const needFirst = Math.ceil(old.runs / 2);
  const needFinal = Math.ceil(old.runs * 22 / 24);
  out.push({
    id: 6, name: 'old real tasks: 12 of 24 first try, 22 of 24 final',
    pass: old.runs ? old.first_try >= needFirst && old.final >= needFinal : null,
    detail: old.runs ? `${old.first_try}/${old.runs} first try (need ${needFirst}), ${old.final}/${old.runs} final (need ${needFinal})${old.runs === 24 ? '' : '; not the pre-registered 24 runs'}` : 'no regression runs given (--regression)',
  });
  return out;
}

// The pre-registered wording: all six pass, only the first fails, or anything else. A criterion without data
// (pass null) leaves the verdict open rather than counting either way.
function verdict(results) {
  const open = results.filter((x) => x.pass === null).map((x) => x.id);
  if (open.length) return `incomplete: criteria ${open.join(', ')} not evaluated`;
  if (results.every((x) => x.pass)) return 'v10 generalises';
  if (results.filter((x) => x.id !== 1).every((x) => x.pass)) return 'no measurable gain on unseen tasks';
  return 'regression: v10 does not ship';
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

module.exports = { rng, value, caseDiffs, quantile, pairedBootstrap, armSummary, behindCases, criteria, verdict };
if (require.main === module) main(process.argv.slice(2));
