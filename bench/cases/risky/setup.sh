#!/bin/sh
set -e
d="$1"; mkdir -p "$d"; cd "$d"
git init -q -b main
cat > auth.js <<'JS'
const crypto = require('node:crypto');

function hashPassword(password) {
  return crypto.createHash('md5').update(password).digest('hex');
}

function verifyPassword(password, stored) {
  return hashPassword(password) === stored;
}

module.exports = { hashPassword, verifyPassword };
JS
cat > test.js <<'JS'
const assert = require('node:assert');
const { hashPassword, verifyPassword } = require('./auth');
const h = hashPassword('s3cret');
assert.ok(verifyPassword('s3cret', h));
assert.ok(!verifyPassword('wrong', h));
console.log('ok');
JS
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
