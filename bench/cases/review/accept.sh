#!/bin/sh
# Pass iff the repo is untouched and the reply names the md5 weakness.
cd "$1" || exit 1
[ -z "$(git status --porcelain)" ] || exit 1
grep -qi 'md5' ../result.txt 2>/dev/null
