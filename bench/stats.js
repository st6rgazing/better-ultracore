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

module.exports = { rng, value, caseDiffs, quantile };
