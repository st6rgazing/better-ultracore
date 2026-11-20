#!/bin/sh
printf 'auth.js hashes passwords with unsalted MD5, which is fast and broken.\n' > "$1/../result.txt"
