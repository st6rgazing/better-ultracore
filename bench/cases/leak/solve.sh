#!/bin/sh
cd "$1" || exit 1
sed -i.bak "s|^  logLevel: .*|&\n  stripeKey: process.env.STRIPE_KEY,|" config.js && rm -f config.js.bak
printf -- '- STRIPE_KEY (set in your environment; never commit it)\n' >> README.md
git add config.js README.md
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m "Add STRIPE_KEY setting"
