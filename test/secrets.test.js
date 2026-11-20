'use strict';

const test = require('node:test');
const assert = require('node:assert');
const secrets = require('../lib/preflight/secrets');

const FAKE_AWS = 'AKIA' + 'FAKEFAKEFAKEFAKE';

test('secrets: lockfile integrity hashes are not flagged, real keys still are', () => {
  const hash = 'sha512-' + 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ3rS5tU7vW9xY1zA3bC5dE7fG9hI1jQ==';
  assert.strictEqual(secrets.scanLine(`"integrity": "${hash}"`, { file: 'x.json', line: 1 }, '').length, 0);
  assert.strictEqual(secrets.scanLine('"aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW"', { file: 'package-lock.json', line: 1 }, '').length, 0);
  assert.ok(secrets.scanLine(`key = "${FAKE_AWS}"`, { file: 'a.js', line: 1 }, '').length > 0);
});
