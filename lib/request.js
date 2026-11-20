'use strict';
const fs = require('node:fs');

// Request text from --request-file (`-` reads stdin) or --request. Trailing newline is trimmed.
function readRequest(flags) {
  const file = flags['request-file'];
  if (typeof file === 'string') return fs.readFileSync(file === '-' ? 0 : file, 'utf8').replace(/\r?\n$/, '');
  return typeof flags.request === 'string' ? flags.request : '';
}

module.exports = { readRequest };
