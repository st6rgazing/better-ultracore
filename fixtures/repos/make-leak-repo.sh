#!/usr/bin/env bash
# Usage: make-leak-repo.sh <dir>
# Creates a git repo: clean commit, then a commit adding a fake AWS key,
# plus an untracked dist/app.js.map embedding a fake GitHub token.
# Fake values are assembled at runtime so this file never holds a full pattern.
set -euo pipefail
dir=${1:?usage: make-leak-repo.sh <dir>}
mkdir -p "$dir" && cd "$dir"
git init -q
git config user.email test@example.com
git config user.name test

echo 'console.log("hello");' > app.js
git add . && git commit -qm "clean commit"

aws_key='AKIA''FAKEFAKEFAKEFAKE'
printf 'module.exports = { key: "%s" };\n' "$aws_key" > config.js
git add . && git commit -qm "add config"

gh_token='ghp''_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000'
mkdir -p dist
echo 'console.log("hello");' > dist/app.js
printf '{"version":3,"sources":["src/main.js"],"sourcesContent":["const t = \\"%s\\";"]}\n' "$gh_token" > dist/app.js.map
