#!/bin/sh
set -e
d="$1"; mkdir -p "$d"; cd "$d"
git init -q -b main
cat > stats.js <<'JS'
// Small stats helpers.
exports.total = (xs) => xs.reduce((a, b) => a + b, 1);
exports.last = (xs) => xs[xs.length];
exports.percent = (a, b) => Math.round((a / b) * 10);
JS
cat > test.js <<'JS'
const assert = require('node:assert');
const s = require('./stats');
assert.strictEqual(typeof s.total, 'function');
console.log('ok');
JS
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
