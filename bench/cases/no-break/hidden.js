// Smoke: every route answers 200, existing pages keep their content, settings has a back link/button.
const assert = require('node:assert');
const { route } = require(require('node:path').join(process.argv[2], 'router'));
const want = { '/': 'Settings', '/about': 'About us', '/settings': 'Settings' };
for (const [p, text] of Object.entries(want)) {
  const r = route(p);
  assert.strictEqual(r.status, 200, p);
  assert.ok(r.body.includes(text), p);
}
assert.match(route('/settings').body, /<(a|button)[^>]*>[^<]*back/i);
