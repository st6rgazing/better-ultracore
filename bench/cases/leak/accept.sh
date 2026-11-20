#!/bin/sh
cd "$1" || exit 1
needle='sk_''live_'
grep -q 'process\.env\.STRIPE_KEY' config.js || exit 1
grep -q 'STRIPE_KEY' README.md || exit 1
node -e "require('./config')" || exit 1
git log -p --all | grep -q "$needle" && exit 1
git grep -q "$needle" && exit 1
git ls-files --error-unmatch .env >/dev/null 2>&1 && exit 1
exit 0
