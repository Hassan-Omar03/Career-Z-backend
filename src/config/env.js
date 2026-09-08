require('dotenv').config();

module.exports = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5500',
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/careerz',
  // DEV-ONLY: spins up an in-memory MongoDB so the app runs without installing MongoDB locally.
  // Must be false/unset in production - the client's real MongoDB (MONGO_URI) is used instead.
  useMemoryDb: process.env.USE_MEMORY_DB === 'true',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev_access_secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret',
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d'
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: process.env.SMTP_PORT || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'CareerZ <no-reply@careerz.local>'
  }
};
