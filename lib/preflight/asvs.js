'use strict';

const fs = require('node:fs');
const path = require('node:path');

const result = (status, detail) => ({ status, detail });

function readIfExists(dir, file) {
  const p = path.resolve(dir, file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// Every listed route must name an existing test file that mentions the route
// (and, when `needle` is given, also contains it). Otherwise: unverified.
function routeEvidence(dir, item, label, needle) {
  const routes = item.routes || [];
  if (!routes.length) return result('not_applicable', `no ${label} routes configured`);
  const missing = routes.filter(({ route, test }) => {
    const src = test && readIfExists(dir, test);
    return !src || !src.includes(route) || (needle && !needle.test(src));
  });
  return missing.length
    ? result('unverified', `no ${label} test evidence for: ${missing.map(r => r.route).join(', ')}`)
    : result('passed', `${label} tests found for ${routes.length} route(s)`);
}

const evaluators = {
  perRecord: (dir, item) => routeEvidence(dir, item, 'ownership'),
  inputValidation: (dir, item) => routeEvidence(dir, item, 'validation', /\b400\b/),
  auth(dir, item) {
    if (item.noAuth) return result('not_applicable', 'app declares no authentication');
    const src = item.test && readIfExists(dir, item.test);
    return src ? result('passed', `auth test evidence: ${item.test}`) : result('unverified', 'no auth test evidence');
  },
};

module.exports = { evaluators, result, readIfExists };
