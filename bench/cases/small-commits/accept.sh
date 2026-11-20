#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
cd "$1" || exit 1
root=$(git rev-list --max-parents=0 HEAD)
node "$here/hidden.js" "$(pwd)" 2>/dev/null || exit 1
[ "$(git rev-list --count "$root"..HEAD)" -ge 3 ] || exit 1
[ -z "$(git status --porcelain)" ] || exit 1
git log --format=%B "$root"..HEAD | grep -qiE 'co-authored-by|claude|generated with|anthropic' && exit 1
exit 0
