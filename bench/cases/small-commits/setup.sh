#!/bin/sh
set -e
d="$1"; mkdir -p "$d"; cd "$d"
git init -q -b main
echo "'use strict';" > util.js
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
