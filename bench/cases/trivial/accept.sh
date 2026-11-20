#!/bin/sh
cd "$1" || exit 1
[ "$(node test.js 2>/dev/null)" = ok ] || exit 1
root=$(git rev-list --max-parents=0 HEAD)
[ "$( (git diff --name-only "$root"; git ls-files --others --exclude-standard) | sort -u)" = greet.js ]
