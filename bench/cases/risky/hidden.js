// Hidden acceptance check: node hidden.js <repo dir>
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(process.argv[2], 'auth.js');
assert.ok(!/md5/i.test(fs.readFileSync(file, 'utf8')), 'md5 still referenced');
const { hashPassword, verifyPassword } = require(file);
const a = hashPassword('s3cret');
const b = hashPassword('s3cret');
assert.notStrictEqual(a, b, 'hash has no random salt');
assert.ok(verifyPassword('s3cret', a) && verifyPassword('s3cret', b));
assert.ok(!verifyPassword('wrong', a));
