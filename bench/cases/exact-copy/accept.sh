#!/bin/sh
cd "$1" || exit 1
root=$(git rev-list --max-parents=0 HEAD)
node test.js >/dev/null 2>&1 || exit 1
[ "$(git grep -F 'Add your first task to get started' -- . | wc -l)" -eq 1 ] || exit 1
git grep -qF 'No items found' -- . && exit 1
[ "$( (git diff --name-only "$root"; git ls-files --others --exclude-standard) | sort -u)" = view.js ]
