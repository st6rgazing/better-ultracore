const assert = require('node:assert');
const s = require(require('node:path').join(process.argv[2], 'stats'));
assert.strictEqual(s.total([1, 2, 3]), 6);
assert.strictEqual(s.total([]), 0);
assert.strictEqual(s.last([1, 2, 3]), 3);
