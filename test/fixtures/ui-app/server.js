'use strict';
// Test fixture: a dev server with no dependencies. Serves index.html on $PORT.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, 'index.html'));
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
}).listen(Number(process.env.PORT) || 0, '127.0.0.1');
