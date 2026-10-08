const env = require('../config/env');

// The frontends allowed to call this API (CORS) — also the only places a gateway return
// (e.g. JazzCash) may redirect a payer back to.
const allowedOrigins = new Set([
  'https://career-z-zeta.vercel.app',
  ...(env.nodeEnv !== 'production' ? ['http://localhost:5173', 'http://localhost:5500'] : []),
  ...env.clientUrl.split(',').map((value) => value.trim().replace(/\/+$/, '')).filter(Boolean)
]);

// Vite's dev server picks the next free port (5174, 5175, ...) whenever 5173 is
// already taken, so in development we allow any localhost/127.0.0.1 port instead
// of hardcoding one — avoids CORS breaking every time a stray process holds 5173.
const isDevLocalOrigin = (origin) =>
  env.nodeEnv !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

function isAllowedOrigin(origin) {
  return Boolean(origin) && (allowedOrigins.has(origin) || isDevLocalOrigin(origin));
}

module.exports = { isAllowedOrigin };
