#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
cd "$1" || exit 1
[ "$(node test.js 2>/dev/null)" = ok ] || exit 1
node "$here/hidden.js" "$(pwd)" >/dev/null 2>&1
