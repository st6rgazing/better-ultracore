#!/bin/sh
cd "$1" && sed -i.bak -e 's/a + b, 1)/a + b, 0)/' -e 's/xs\[xs.length\]/xs[xs.length - 1]/' stats.js && rm stats.js.bak
