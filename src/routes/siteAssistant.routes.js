const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { ok } = require('../utils/apiResponse');
const assistant = require('../services/siteAssistant.service');

// Public homepage assistant. Each message costs the platform an AI call, so visitors are limited
// per IP (real visitor IP: app trusts the Nginx proxy).
const perMinute = rateLimit({ windowMs: 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'You are sending messages too quickly. Please wait a moment.' } });
const perDay = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Daily message limit reached. Please try again tomorrow.' } });

router.get('/status', asyncHandler(async (req, res) => ok(res, { enabled: (await assistant.status()).enabled })));
router.post('/chat', perMinute, perDay, asyncHandler(async (req, res) => {
  try {
    return ok(res, await assistant.answer(req.body?.messages));
  } catch (err) {
    throw new AppError(err.message, err.statusCode || 500);
  }
}));

module.exports = router;
