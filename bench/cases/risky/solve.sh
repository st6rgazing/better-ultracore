#!/bin/sh
cd "$1" && cat > auth.js <<'JS'
const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, key] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 32);
  return crypto.timingSafeEqual(actual, Buffer.from(key, 'hex'));
}

module.exports = { hashPassword, verifyPassword };
JS
