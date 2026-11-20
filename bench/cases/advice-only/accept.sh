#!/bin/sh
# Advice only: the tree is untouched and a reply exists (../result.txt).
cd "$1" || exit 1
[ -z "$(git status --porcelain)" ] || exit 1
[ -s ../result.txt ]
