#!/bin/sh
set -e
d="$1"; mkdir -p "$d/src"; cd "$d"
git init -q -b main
cat > src/a.js <<'JS'
function fooA() { return 1; }
module.exports = { fooA };
JS
cat > src/b.js <<'JS'
function fooB() { return 2; }
module.exports = { fooB };
JS
cat > index.js <<'JS'
const { fooA } = require('./src/a');
const { fooB } = require('./src/b');
console.log(fooA.name, fooB.name);
JS
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
