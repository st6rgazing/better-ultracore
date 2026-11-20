#!/bin/sh
cd "$1" || exit 1
sed -i.bak 's/fooA/alpha/g' src/a.js index.js && rm -f src/a.js.bak index.js.bak
