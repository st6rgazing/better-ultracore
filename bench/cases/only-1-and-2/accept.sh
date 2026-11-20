#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
cd "$1" || exit 1
root=$(git rev-list --max-parents=0 HEAD)
node "$here/hidden.js" "$(pwd)" 2>/dev/null || exit 1
# bug 3 line byte-identical
[ "$(git show "$root:stats.js" | grep percent)" = "$(grep percent stats.js)" ] || exit 1
[ "$(git diff --numstat "$root" | awk '{n+=$1+$2} END {print n+0}')" -le 12 ]
