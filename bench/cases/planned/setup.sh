#!/bin/sh
# Same todo CLI as the ambiguous case; this task spans code + docs and several steps.
exec sh "$(cd "$(dirname "$0")" && pwd)/../ambiguous/setup.sh" "$1"
