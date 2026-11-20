// Hidden acceptance check: node hidden.js <repo dir>
const assert = require('node:assert');
const path = require('node:path');

const { handleResponse } = require(path.resolve(process.argv[2], 'public', 'app.js'));
const bad = String(handleResponse({ ok: false, status: 500 }));
assert.notStrictEqual(bad, 'Saved');
assert.match(bad, /error|fail/i); // any message that says it failed
assert.strictEqual(handleResponse({ ok: true }), 'Saved');
