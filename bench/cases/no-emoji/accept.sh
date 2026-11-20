#!/bin/sh
# lucide icons present on all three buttons, no emoji anywhere in src.
cd "$1" || exit 1
node -e '
const fs = require("fs");
const src = fs.readFileSync("src/Toolbar.jsx", "utf8");
if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(src)) process.exit(1);
if (!/from .lucide-react./.test(src)) process.exit(1);
if ((src.match(/<[A-Z]\w*\b[^>]*\/>/g) || []).length < 3) process.exit(1);
for (const l of ["Save", "Delete", "Share"]) if (!src.includes(l)) process.exit(1);
'
