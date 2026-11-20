#!/bin/sh
# Width within 75-95% of the original 320px, at most 3 css lines added.
cd "$1" || exit 1
root=$(git rev-list --max-parents=0 HEAD)
w=$(sed -n '/^\.card {/,/^}/p' card.css | sed -n 's/^ *width: *\([0-9]*\)px.*/\1/p')
[ -n "$w" ] && [ "$w" -ge 240 ] && [ "$w" -le 304 ] || exit 1
[ "$(git diff --numstat "$root" | awk '{n+=$1} END {print n+0}')" -le 3 ]
