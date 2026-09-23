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
  },
  // Real Stripe integration (client-provided in production — no keys are baked into this repo).
  // secretKey empty = Stripe is treated as "not configured" and card-checkout is disabled with a
  // clear error, rather than silently pretending to work.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || ''
  },
  // Real Paddle (Billing) integration — CareerZ's primary worldwide card/Apple Pay/Google Pay
  // gateway (client-provided, platform-wide, same pattern as Stripe above). Paddle is a
  // Merchant of Record: CareerZ is the single seller Paddle sees, and pays institutions out
  // separately/internally — Paddle never auto-splits funds to individual institutions.
  paddle: {
    apiKey: process.env.PADDLE_API_KEY || '',
    clientToken: process.env.PADDLE_CLIENT_TOKEN || '',
    webhookSecret: process.env.PADDLE_WEBHOOK_SECRET || '',
    environment: process.env.PADDLE_ENVIRONMENT || 'sandbox' // 'sandbox' | 'production'
  },
  // Real machine translation (spec Part 16F "Smart Language Engine" — Dynamic Translation).
  // provider: 'mymemory' (default — free, no key needed, ~5-10k words/day) or 'libretranslate'
  // (genuinely unlimited and free forever, but only once self-hosted on the client's own VPS —
  // set LIBRETRANSLATE_URL to switch, e.g. http://localhost:5555 or their server's address).
  translation: {
    provider: process.env.TRANSLATION_PROVIDER || 'mymemory',
    myMemoryEmail: process.env.MYMEMORY_EMAIL || '', // optional — raises the free daily cap
    libretranslateUrl: process.env.LIBRETRANSLATE_URL || '',
    libretranslateApiKey: process.env.LIBRETRANSLATE_API_KEY || '',
    // Automatic fallback when the primary (self-hosted LibreTranslate) is overloaded, slow or
    // down — never leaves translation completely broken. Google Cloud Translation API key.
    googleTranslateApiKey: process.env.GOOGLE_TRANSLATE_API_KEY || ''
  },
  // Platform-wide media storage (client-provided, free-tier Cloudinary account works) — separate
  // from the per-user BYOK MediaCredential (used only for the teacher's own AI-video pipeline).
  // This is for universal, unavoidable uploads (profile photo, campus photos, locker documents)
  // that can't reasonably require every single user to connect their own storage account.
  // cloudName empty = "not configured", and every upload flow below keeps working as before
  // (small resized base64) rather than breaking — this only upgrades storage once it's set.
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || ''
  },
  // Key used to encrypt each user's own BYOK AI API key at rest (spec Part 17E "AI Security" —
  // "کسی Institution کی API Key ... Encrypt ہو کر محفوظ ہوگی"). Falls back to deriving from the
  // JWT secret only so dev/test never crashes for lack of a dedicated var — production should
  // set ENCRYPTION_KEY explicitly and keep it stable (rotating it makes stored keys unreadable).
  encryptionKey: process.env.ENCRYPTION_KEY || `careerz_dev_derived_${process.env.JWT_ACCESS_SECRET || 'dev_access_secret'}`
};
