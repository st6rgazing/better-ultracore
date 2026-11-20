#!/bin/sh
set -e
d="$1"; mkdir -p "$d/public"; cd "$d"
git init -q -b main
cat > server.js <<'JS'
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/save') {
    const failing = process.env.FAIL === '1';
    res.writeHead(failing ? 500 : 200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: !failing }));
  }
  const file = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(file, (err, data) => {
    res.writeHead(err ? 404 : 200);
    res.end(err ? 'not found' : data);
  });
});

if (require.main === module) server.listen(process.env.PORT || 3000);
module.exports = server;
JS
cat > public/index.html <<'HTML'
<!doctype html>
<button id="save">Save</button> <span id="status"></span>
<script src="app.js"></script>
HTML
cat > public/app.js <<'JS'
// Maps a fetch Response to the message shown next to the save button.
function handleResponse(res) {
  return 'Saved';
}

if (typeof document !== 'undefined') {
  document.getElementById('save').addEventListener('click', async () => {
    const res = await fetch('/api/save', { method: 'POST' });
    document.getElementById('status').textContent = handleResponse(res);
  });
}

if (typeof module !== 'undefined') module.exports = { handleResponse };
JS
cat > test.js <<'JS'
const assert = require('node:assert');
const { handleResponse } = require('./public/app.js');

assert.strictEqual(handleResponse({ ok: true }), 'Saved');
assert.notStrictEqual(handleResponse({ ok: false, status: 500 }), 'Saved');
console.log('ok');
JS
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
