#!/bin/sh
set -e
d="$1"; mkdir -p "$d"; cd "$d"
git init -q -b main
cat > greet.js <<'JS'
module.exports = function greet(name) { return 'Hello ' + name; };
JS
cat > test.js <<'JS'
const assert = require('node:assert');
const greet = require('./greet');
assert.strictEqual(greet('Ana'), 'Hello, Ana!');
console.log('ok');
JS
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
