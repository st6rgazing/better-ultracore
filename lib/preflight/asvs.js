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
  // Static scan of the server source for hardening signals.
  prodConfig(dir, item) {
    const src = readIfExists(dir, item.serverFile || 'server.js');
    if (!src) return result('unverified', 'server file not found');
    const signals = {
      'x-powered-by disabled': /disable\(['"]x-powered-by['"]\)|helmet\(/.test(src),
      'security headers': /x-content-type-options|helmet\(/i.test(src),
      'NODE_ENV production check': /NODE_ENV/.test(src),
    };
    const missing = Object.keys(signals).filter(k => !signals[k]);
    return missing.length ? result('failed', `missing: ${missing.join(', ')}`) : result('passed', 'hardening signals present');
  },
  sessions(dir, item) {
    const src = readIfExists(dir, item.serverFile || 'server.js');
    if (!src) return result('unverified', 'server file not found');
    if (!/res\.cookie\(|set-cookie/i.test(src)) return result('not_applicable', 'server sets no cookies');
    const missing = ['httpOnly', 'secure', 'sameSite'].filter(f => !new RegExp(f, 'i').test(src));
    return missing.length ? result('failed', `cookie flags missing: ${missing.join(', ')}`) : result('passed', 'cookie flags present');
  },
  auth(dir, item) {
    if (item.noAuth) return result('not_applicable', 'app declares no authentication');
    const src = item.test && readIfExists(dir, item.test);
    return src ? result('passed', `auth test evidence: ${item.test}`) : result('unverified', 'no auth test evidence');
  },
};

module.exports = { evaluators, result, readIfExists };
