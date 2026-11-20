#!/bin/sh
# Acceptance for the corrected task: only fooA is renamed.
cd "$1" || exit 1
[ "$(node index.js 2>/dev/null)" = "alpha fooB" ] || exit 1
root=$(git rev-list --max-parents=0 HEAD)
git diff --quiet "$root" -- src/b.js
