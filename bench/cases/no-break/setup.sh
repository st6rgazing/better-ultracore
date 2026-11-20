#!/bin/sh
set -e
d="$1"; mkdir -p "$d"; cd "$d"
git init -q -b main
cat > pages.js <<'JS'
const layout = (title, body) => `<html><title>${title}</title><body><h1>${title}</h1>${body}</body></html>`;
module.exports = {
  '/': () => layout('Home', '<a href="/about">About</a> <a href="/settings">Settings</a>'),
  '/about': () => layout('About', '<p>About us</p>'),
  '/settings': () => layout('Settings', '<p>Settings</p>'),
};
JS
cat > router.js <<'JS'
const pages = require('./pages');
exports.route = (path) => (pages[path] ? { status: 200, body: pages[path]() } : { status: 404, body: 'not found' });
JS
cat > test.js <<'JS'
const assert = require('node:assert');
const { route } = require('./router');
assert.ok(route('/').body.includes('About'));
assert.strictEqual(route('/nope').status, 404);
console.log('ok');
JS
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
