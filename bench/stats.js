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

module.exports = { rng, value };
