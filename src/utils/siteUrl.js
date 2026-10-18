const env = require('../config/env');

// The public address used in links inside emails: PUBLIC_SITE_URL, else the first CLIENT_URL.
// The API is served under the same address at /api (nginx), so links work for both.
function siteUrl() {
  const raw = process.env.PUBLIC_SITE_URL || String(env.clientUrl || '').split(',')[0] || '';
  return raw.trim().replace(/\/+$/, '');
}

const absolute = (path) => (path ? `${siteUrl()}${String(path).startsWith('/') ? '' : '/'}${path}` : siteUrl());

module.exports = { siteUrl, absolute };
