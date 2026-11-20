#!/bin/sh
# Hidden check lives in this case dir, never in the run dir during the model run.
here=$(cd "$(dirname "$0")" && pwd)
cd "$1" || exit 1
git show "$(git rev-list --max-parents=0 HEAD):test.js" > .orig-test.js || exit 1
rm -f todos.json
node .orig-test.js >/dev/null 2>&1; rc=$?
rm -f .orig-test.js todos.json
[ $rc -eq 0 ] || exit 1
node "$here/hidden.js" "$(pwd)"
