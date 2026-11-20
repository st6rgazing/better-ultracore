const assert = require('node:assert');
const u = require(require('node:path').join(process.argv[2], 'util'));
assert.strictEqual(u.double(4), 8);
assert.strictEqual(u.isEven(3), false);
assert.strictEqual(u.clamp(9, 0, 5), 5);
