#!/bin/sh
cd "$1" && git fetch -q origin && git show origin/main:VERSION > answer.txt
