#!/bin/sh
cd "$1" || exit 1
g="git -c user.name=dev -c user.email=dev@example.invalid"
echo "exports.double = (n) => n * 2;" >> util.js; git add util.js; $g commit -q -m "Add double"
echo "exports.isEven = (n) => n % 2 === 0;" >> util.js; git add util.js; $g commit -q -m "Add isEven"
echo "exports.clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));" >> util.js; git add util.js; $g commit -q -m "Add clamp"
