const User = require('../models/User');
const Country = require('../models/Country');
const Language = require('../models/Language');
const Currency = require('../models/Currency');
const FeatureFlag = require('../models/FeatureFlag');

const countries = [
  { name: 'Pakistan', code: 'PK', dialCode: '+92', defaultCurrency: 'PKR', defaultLanguage: 'ur', timeZone: 'Asia/Karachi', dateFormat: 'DD/MM/YYYY' },
  { name: 'Saudi Arabia', code: 'SA', dialCode: '+966', defaultCurrency: 'SAR', defaultLanguage: 'ar', timeZone: 'Asia/Riyadh', dateFormat: 'DD/MM/YYYY' },
  { name: 'United Arab Emirates', code: 'AE', dialCode: '+971', defaultCurrency: 'AED', defaultLanguage: 'ar', timeZone: 'Asia/Dubai', dateFormat: 'DD/MM/YYYY' },
  { name: 'United States', code: 'US', dialCode: '+1', defaultCurrency: 'USD', defaultLanguage: 'en', timeZone: 'America/New_York', dateFormat: 'MM/DD/YYYY' },
  { name: 'United Kingdom', code: 'GB', dialCode: '+44', defaultCurrency: 'GBP', defaultLanguage: 'en', timeZone: 'Europe/London', dateFormat: 'DD/MM/YYYY' }
];

const languages = [
  { name: 'English', code: 'en', direction: 'ltr', isDefault: true },
  { name: 'Urdu', code: 'ur', direction: 'rtl' },
  { name: 'Arabic', code: 'ar', direction: 'rtl' }
];

const currencies = [
  { name: 'US Dollar', code: 'USD', symbol: '$', symbolPosition: 'left', isDefault: true, exchangeRateToUSD: 1 },
  { name: 'Pakistani Rupee', code: 'PKR', symbol: 'Rs', symbolPosition: 'left', exchangeRateToUSD: 0.0036 },
  { name: 'Saudi Riyal', code: 'SAR', symbol: 'SAR', symbolPosition: 'left', exchangeRateToUSD: 0.27 },
  { name: 'UAE Dirham', code: 'AED', symbol: 'AED', symbolPosition: 'left', exchangeRateToUSD: 0.27 },
  { name: 'British Pound', code: 'GBP', symbol: '£', symbolPosition: 'left', exchangeRateToUSD: 1.27 }
];

const featureFlags = [
  { key: 'jobs', label: 'Jobs & Recruitment', enabled: true },
  { key: 'marketplace', label: 'Marketplace', enabled: true },
  { key: 'scholarships', label: 'Scholarships & Donations', enabled: true },
  { key: 'ai_assistant', label: 'AI Assistant', enabled: true },
  { key: 'freelancer_hub', label: 'Freelancer & Services Hub', enabled: true },
  { key: 'advertisements', label: 'Advertisements', enabled: false }
];

// Idempotent - safe to call every time the server starts (uses upsert / existence checks).
// Does NOT open or close the database connection - the caller is responsible for that.
async function runSeedData() {
  for (const c of countries) {
    await Country.findOneAndUpdate({ code: c.code }, c, { upsert: true, new: true });
  }
  for (const l of languages) {
    await Language.findOneAndUpdate({ code: l.code }, l, { upsert: true, new: true });
  }
  for (const cur of currencies) {
    await Currency.findOneAndUpdate({ code: cur.code }, cur, { upsert: true, new: true });
  }
  for (const f of featureFlags) {
    await FeatureFlag.findOneAndUpdate({ key: f.key, scope: 'global', scopeValue: null }, f, { upsert: true, new: true });
  }
  console.log(`[SEED] Countries/Languages/Currencies/FeatureFlags ensured (${countries.length}/${languages.length}/${currencies.length}/${featureFlags.length}).`);

  const adminEmail = 'superadmin@careerz.local';
  const existingAdmin = await User.findOne({ email: adminEmail });
  if (!existingAdmin) {
    const passwordHash = await User.hashPassword('SuperAdmin@123');
    await User.create({
      fullName: 'CareerZ Super Admin',
      email: adminEmail,
      passwordHash,
      roles: ['super_admin'],
      emailVerified: true,
      country: 'PK',
      language: 'en'
    });
    console.log('[SEED] Super Admin created -> email: superadmin@careerz.local / password: SuperAdmin@123');
    console.log('[SEED] Change this password immediately after first login.');
  } else {
    console.log('[SEED] Super Admin already exists, skipping.');
  }
}

module.exports = { runSeedData };

// Allows `npm run seed` to be executed standalone against a real MONGO_URI
// (this only makes sense with USE_MEMORY_DB=false, since a standalone run's
// in-memory database is discarded the moment this process exits).
if (require.main === module) {
  require('dotenv').config();
  const mongoose = require('mongoose');
  const connectDB = require('../config/db');

  (async () => {
    try {
      await connectDB();
      await runSeedData();
      console.log('[SEED] Done.');
      await mongoose.disconnect();
      process.exit(0);
    } catch (err) {
      console.error('[SEED] Failed:', err);
      process.exit(1);
    }
  })();
}
