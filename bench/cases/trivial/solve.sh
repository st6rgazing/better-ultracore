#!/bin/sh
cd "$1" && cat > greet.js <<'JS'
module.exports = function greet(name) { return 'Hello, ' + name + '!'; };
JS
