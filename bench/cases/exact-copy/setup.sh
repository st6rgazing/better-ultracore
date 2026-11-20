#!/bin/sh
set -e
d="$1"; mkdir -p "$d"; cd "$d"
git init -q -b main
cat > view.js <<'JS'
exports.render = (items) => (items.length ? items.map((i) => `* ${i}`).join('\n') : 'No items found');
JS
cat > test.js <<'JS'
const assert = require('node:assert');
const { render } = require('./view');
assert.strictEqual(render(['a', 'b']), '* a\n* b');
console.log('ok');
JS
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
