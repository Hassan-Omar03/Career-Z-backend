const Country = require('../models/Country');
const Language = require('../models/Language');
const Currency = require('../models/Currency');
const FeatureFlag = require('../models/FeatureFlag');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

// GET /api/config/public - used by the frontend to build country/language/currency selectors.
const getPublicConfig = asyncHandler(async (req, res) => {
  const [countries, languages, currencies, features] = await Promise.all([
    Country.find({ active: true, hidden: false }).sort({ name: 1 }),
    Language.find({ active: true }).sort({ name: 1 }),
    Currency.find({ active: true }).sort({ name: 1 }),
    FeatureFlag.find({ scope: 'global' })
  ]);

  const featureMap = {};
  features.forEach((f) => (featureMap[f.key] = f.enabled));

  return ok(res, { countries, languages, currencies, features: featureMap });
});

// ---- Countries (Super Admin) ----
const createCountry = asyncHandler(async (req, res) => {
  const country = await Country.create(req.body);
  return created(res, country);
});

const updateCountry = asyncHandler(async (req, res) => {
  const country = await Country.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!country) throw new AppError('Country not found.', 404);
  return ok(res, country);
});

const listCountries = asyncHandler(async (req, res) => {
  const countries = await Country.find().sort({ name: 1 });
  return ok(res, countries);
});

// ---- Languages (Super Admin) ----
const createLanguage = asyncHandler(async (req, res) => {
  const language = await Language.create(req.body);
  return created(res, language);
});

const updateLanguage = asyncHandler(async (req, res) => {
  const language = await Language.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!language) throw new AppError('Language not found.', 404);
  return ok(res, language);
});

const listLanguages = asyncHandler(async (req, res) => {
  const languages = await Language.find().sort({ name: 1 });
  return ok(res, languages);
});

// ---- Currencies (Super Admin) ----
const createCurrency = asyncHandler(async (req, res) => {
  const currency = await Currency.create(req.body);
  return created(res, currency);
});

const updateCurrency = asyncHandler(async (req, res) => {
  const currency = await Currency.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!currency) throw new AppError('Currency not found.', 404);
  return ok(res, currency);
});

const listCurrencies = asyncHandler(async (req, res) => {
  const currencies = await Currency.find().sort({ name: 1 });
  return ok(res, currencies);
});

// ---- Feature flags (Super Admin) ----
const upsertFeatureFlag = asyncHandler(async (req, res) => {
  const { key, label, enabled, scope, scopeValue } = req.body;
  if (!key) throw new AppError('Feature key is required.', 422);

  const flag = await FeatureFlag.findOneAndUpdate(
    { key, scope: scope || 'global', scopeValue: scopeValue || null },
    { key, label, enabled, scope: scope || 'global', scopeValue: scopeValue || null },
    { new: true, upsert: true, runValidators: true }
  );
  return ok(res, flag);
});

const listFeatureFlags = asyncHandler(async (req, res) => {
  const flags = await FeatureFlag.find().sort({ key: 1 });
  return ok(res, flags);
});

module.exports = {
  getPublicConfig,
  createCountry, updateCountry, listCountries,
  createLanguage, updateLanguage, listLanguages,
  createCurrency, updateCurrency, listCurrencies,
  upsertFeatureFlag, listFeatureFlags
};
