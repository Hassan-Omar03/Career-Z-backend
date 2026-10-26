const router = require('express').Router();
const ctrl = require('../controllers/resume.controller');
const { protect } = require('../middleware/auth');

// Public — no login required to view a shared Career Portfolio link.
router.get('/public/:userId', ctrl.getPublicResume);

router.use(protect);

router.get('/me', ctrl.getMyResume);
router.patch('/me', ctrl.updateMyResume);

// Uploaded CV file (private).
router.post('/me/cv-file', ctrl.uploadCvFile);
router.delete('/me/cv-file', ctrl.removeCvFile);
router.get('/me/cv-file', ctrl.downloadCvFile);

// AI CV draft with the person's own AI key; returned for review, never saved.
const aiDraftLimiter = require('express-rate-limit')({ windowMs: 60 * 60 * 1000, max: process.env.NODE_ENV === 'test' ? 1000 : 20, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many AI drafts. Try again in an hour.' } });
router.post('/me/ai-draft', aiDraftLimiter, require('../utils/asyncHandler')(async (req, res) => require('../utils/apiResponse').ok(res, await require('../services/cvAiDraft.service').draft(req.user, req.body || {}), 'AI draft ready. Review it, then save.')));

// CV autofill from your own records, and named CV versions (max 5).
const variants = require('../controllers/resumeVariant.controller');
router.get('/autofill', variants.preview);
router.post('/me/autofill', variants.fillMain);
router.get('/variants', variants.list);
router.post('/variants', variants.create);
router.patch('/variants/:id', variants.update);
router.post('/variants/:id/autofill', variants.fillVariant);
router.post('/variants/:id/default', variants.makeDefault);
router.delete('/variants/:id', variants.remove);

// Saved cover letters (max 20), reused on the apply form.
const CoverLetter = require('../models/CoverLetter');
const AppError = require('../utils/AppError');
const wrapCl = require('../utils/asyncHandler'), { ok: okCl, created: createdCl } = require('../utils/apiResponse');
const cleanLetter = (b = {}) => {
  const out = { title: String(b.title || '').trim().slice(0, 120), company: String(b.company || '').trim().slice(0, 160), role: String(b.role || '').trim().slice(0, 160), body: String(b.body || '').trim().slice(0, 8000) };
  if (!out.title) throw new AppError('Give the cover letter a name.', 422);
  if (out.body.length < 30) throw new AppError('Write the cover letter (at least a couple of sentences).', 422);
  return out;
};
const ownLetter = async (req) => {
  const row = require('mongoose').isValidObjectId(req.params.id) ? await CoverLetter.findOne({ _id: req.params.id, user: req.user._id }) : null;
  if (!row) throw new AppError('Cover letter not found.', 404);
  return row;
};
router.get('/cover-letters', wrapCl(async (req, res) => okCl(res, await CoverLetter.find({ user: req.user._id }).sort({ updatedAt: -1 }))));
router.post('/cover-letters', wrapCl(async (req, res) => {
  if ((await CoverLetter.countDocuments({ user: req.user._id })) >= CoverLetter.MAX_LETTERS) throw new AppError(`You can keep up to ${CoverLetter.MAX_LETTERS} cover letters. Delete one first.`, 409);
  return createdCl(res, await CoverLetter.create({ ...cleanLetter(req.body), user: req.user._id }), 'Cover letter saved.');
}));
router.patch('/cover-letters/:id', wrapCl(async (req, res) => { const row = await ownLetter(req); Object.assign(row, cleanLetter(req.body)); await row.save(); return okCl(res, row, 'Cover letter saved.'); }));
router.delete('/cover-letters/:id', wrapCl(async (req, res) => { const row = await ownLetter(req); await row.deleteOne(); return okCl(res, null, 'Cover letter deleted.'); }));

module.exports = router;
