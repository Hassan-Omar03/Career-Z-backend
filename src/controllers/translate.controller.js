const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { translateTexts, isTranslationConfigured } = require('../services/translation.service');

const SUPPORTED_LANGS = ['en', 'ur', 'ar', 'zh', 'fr', 'de', 'es', 'tr', 'hi', 'bn', 'fa', 'ru', 'ms', 'id', 'pt', 'it', 'ja', 'ko'];
const MAX_TEXTS_PER_REQUEST = 200;

// GET /api/translate/config — the frontend needs to know whether live translation is available
// at all before it starts walking the DOM trying to translate anything.
const getTranslationConfig = asyncHandler(async (req, res) => {
  return ok(res, { enabled: isTranslationConfigured(), supportedLanguages: SUPPORTED_LANGS });
});

// POST /api/translate — batch-translates an array of short UI strings into targetLang. Public
// (no auth) — translation is read-only and has no per-user data, same as GET /config public
// endpoints elsewhere in this app.
const translateBatch = asyncHandler(async (req, res) => {
  const { texts, targetLang } = req.body;
  if (!Array.isArray(texts) || texts.length === 0) throw new AppError('texts must be a non-empty array.', 422);
  if (texts.length > MAX_TEXTS_PER_REQUEST) throw new AppError(`No more than ${MAX_TEXTS_PER_REQUEST} texts per request.`, 422);
  if (!targetLang || !SUPPORTED_LANGS.includes(targetLang)) throw new AppError('A supported targetLang is required.', 422);

  try {
    const translations = await translateTexts(texts, targetLang);
    return ok(res, { translations });
  } catch (err) {
    throw new AppError(err.message, err.statusCode || 500);
  }
});

module.exports = { getTranslationConfig, translateBatch };
