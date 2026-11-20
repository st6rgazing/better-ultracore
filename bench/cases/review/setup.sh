#!/bin/sh
# Same md5 auth module as the risky case; this time the user only wants a review.
exec sh "$(cd "$(dirname "$0")" && pwd)/../risky/setup.sh" "$1"
