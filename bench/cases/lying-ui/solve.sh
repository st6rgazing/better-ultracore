#!/bin/sh
cd "$1" && node -e "
const fs=require('fs');let s=fs.readFileSync('public/app.js','utf8');
s=s.replace(\"return 'Saved';\",\"return res.ok ? 'Saved' : 'Error: save failed (' + res.status + ')';\");
fs.writeFileSync('public/app.js',s);"
