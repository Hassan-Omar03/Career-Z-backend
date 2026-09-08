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

const app = express();

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    },
    credentials: true
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan(env.nodeEnv === 'development' ? 'dev' : 'combined'));

// Rate limit auth endpoints to slow brute-force attempts.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' }
});
app.use('/api/auth', authLimiter);

// Vercel imports this app directly, without executing server.js.
app.use('/api', async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch {
    res.status(503).json({ success: false, message: 'Database connection unavailable. Please try again shortly.', errors: null });
  }
});
app.use('/api', routes);

app.get('/', (req, res) => {
  res.json({ success: true, message: 'CareerZ API is running' });
});

app.use(notFound);
app.use(errorHandler);

module.exports = app;
