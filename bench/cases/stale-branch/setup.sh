#!/bin/sh
set -e
d="$1"; mkdir -p "$d"; d=$(cd "$d" && pwd)
origin="$(dirname "$d")/$(basename "$d")-origin.git"
g() { git -c user.name=fixture -c user.email=fixture@example.invalid "$@"; }
rm -rf "$origin"
git init -q --bare -b main "$origin"
seed=$(mktemp -d)
git clone -q "$origin" "$seed/a" 2>/dev/null
(cd "$seed/a" && git checkout -q -b main && echo 1.0.0 > VERSION && echo "# app" > README.md && git add -A && g commit -q -m "Release 1.0.0" && git push -q origin main)
git clone -q "$origin" "$d"
# A second clone advances origin; the local clone stays at 1.0.0 until someone fetches.
(cd "$seed/a" && echo 2.0.0 > VERSION && g commit -q -am "Bump version to 2.0.0" && git push -q origin main)
rm -rf "$seed"
