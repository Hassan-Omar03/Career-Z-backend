const router = require('express').Router();
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const wrap = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const AppError = require('../utils/AppError');
const Setting = require('../models/Setting');

// Home page text the Super Admin edits without code (the rest of the pages live in /pages).
const KEY = 'site_content_home';
const FIELDS = { eyebrow: 80, titleStart: 80, titleEmphasis: 60, titleEnd: 80, lead: 400, primaryLabel: 40, secondaryLabel: 40, announcement: 200 };
const read = async () => (await Setting.findOne({ key: KEY }).lean())?.value || {};

router.get('/home', wrap(async (req, res) => ok(res, await read())));
router.put('/home', protect, requireRole('admin', 'super_admin'), wrap(async (req, res) => {
  const value = {};
  for (const [k, max] of Object.entries(FIELDS)) {
    if (req.body?.[k] === undefined) continue;
    const v = String(req.body[k] ?? '').trim();
    if (v.length > max) throw new AppError(`${k} is too long (max ${max} characters).`, 422);
    value[k] = v;
  }
  const next = { ...(await read()), ...value };
  await Setting.findOneAndUpdate({ key: KEY }, { $set: { value: next } }, { upsert: true });
  return ok(res, next, 'Home page saved.');
}));

module.exports = router;
