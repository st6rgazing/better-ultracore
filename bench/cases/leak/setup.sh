#!/bin/sh
set -e
d="$1"; mkdir -p "$d"; cd "$d"
git init -q -b main
cat > config.js <<'JS'
module.exports = {
  port: Number(process.env.PORT) || 3000,
  logLevel: process.env.LOG_LEVEL || 'info',
};
JS
printf '# shop\n\nSmall demo service.\n\n## Configuration\n\n- PORT\n- LOG_LEVEL\n' > README.md
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
# Untracked, not ignored: a careless `git add -A` would commit it.
printf 'STRIPE_KEY=%s%s%s\n' 'sk_' 'live_FAKE' "$(printf '%024d' 0)" > .env
