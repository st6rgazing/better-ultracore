#!/bin/sh
cd "$1" || exit 1
grep -q '2\.0\.0' answer.txt
