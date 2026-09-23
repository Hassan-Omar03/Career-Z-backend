const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const connectDB = require('./config/db');
const allowedOrigins = new Set([
  'https://career-z-zeta.vercel.app',
  ...(env.nodeEnv !== 'production' ? ['http://localhost:5173', 'http://localhost:5500'] : []),
  ...env.clientUrl.split(',').map(value => value.trim().replace(/\/+$/, '')).filter(Boolean)
]);
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { maintenanceGate } = require('./middleware/maintenance');
const { metricsMiddleware } = require('./services/platformMetrics');
const { emergencyControls } = require('./middleware/emergencyControls');
const { handleStripeWebhook, handlePaddleWebhook } = require('./controllers/webhook.controller');

const app = express();

// Vite's dev server picks the next free port (5174, 5175, ...) whenever 5173 is
// already taken, so in development we allow any localhost/127.0.0.1 port instead
// of hardcoding one — avoids CORS breaking every time a stray process holds 5173.
const isDevLocalOrigin = (origin) =>
  env.nodeEnv !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin) || isDevLocalOrigin(origin));
    },
    credentials: true
  })
);
// Stripe webhook signature verification needs the exact raw request bytes, so this route is
// registered with express.raw() BEFORE the global express.json() below — a JSON-parsed-and-
// restringified body would never match the signature Stripe sends. Connects the DB itself
// (the /api-wide connectDB middleware below hasn't run yet at this point in the chain).
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    await connectDB();
    await handleStripeWebhook(req, res);
  } catch (err) {
    next(err);
  }
});

// Same raw-body requirement as Stripe above — Paddle's HMAC signature is computed over the
// exact request bytes.
app.post('/api/webhooks/paddle', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    await connectDB();
    await handlePaddleWebhook(req, res);
  } catch (err) {
    next(err);
  }
});

// 2mb was fine before real file uploads existed anywhere in the app; Digital Locker documents
// and profile photos now arrive as base64 data URIs in this same JSON body (no S3/Cloudinary is
// connected), which inflates a file's raw size by ~33% — raised to comfortably fit a few-MB PDF.
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined'));

// Rate limit auth endpoints to slow brute-force attempts. Loosened outside production — a real
// dev session with several tabs open (each independently retrying a failed token refresh) can
// legitimately burn through 50 requests in 15 minutes without anything actually being wrong.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.nodeEnv === 'production' ? 50 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' }
});
app.use('/api/auth', authLimiter);

// Translation is public (no login) but each call costs the client real money against their
// Google Translate quota — rate-limited harder than general traffic to bound that cost.
const translateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many translation requests. Please slow down.' }
});
app.use('/api/translate', translateLimiter);

// Vercel imports this app directly, without executing server.js.
app.use('/api', async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch {
    res.status(503).json({ success: false, message: 'Database connection unavailable. Please try again shortly.', errors: null });
  }
});
app.use('/api', metricsMiddleware);
app.use('/api', maintenanceGate);
app.use('/api', emergencyControls);
app.use('/api', routes);

app.get('/', (req, res) => {
  res.json({ success: true, message: 'CareerZ API is running' });
});

app.use(notFound);
app.use(errorHandler);

module.exports = app;
