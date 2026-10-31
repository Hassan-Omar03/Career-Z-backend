const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { ok } = require('../utils/apiResponse');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const listings = require('../services/publicListings.service');
const DonorPublicProfile = require('../models/DonorPublicProfile');

// Public discovery API for the homepage and its "View All" pages. No login: visitors browse
// everything here; applying, ordering and other actions use the normal protected endpoints.

const validId = (id) => require('mongoose').isValidObjectId(id);
const detail = (loader, label) => asyncHandler(async (req, res) => {
  if (!validId(req.params.id)) throw new AppError(`${label} not found.`, 404);
  const row = await loader(req.params.id);
  if (!row) throw new AppError(`${label} not found or no longer available.`, 404);
  return ok(res, row);
});

router.get('/home', asyncHandler(async (req, res) => ok(res, await listings.home())));
router.get('/activity', asyncHandler(async (req, res) => ok(res, await require('../services/publicActivity.service').activity())));
router.get('/stats', asyncHandler(async (req, res) => ok(res, await listings.stats())));
router.get('/jobs', asyncHandler(async (req, res) => ok(res, await listings.listJobs(req.query))));
// Opening the public job page counts as a view (employer analytics).
router.get('/jobs/:id', detail(async (id) => { const row = await listings.jobDetail(id); if (row) require('../models/Job').updateOne({ _id: id }, { $inc: { views: 1 } }).catch(() => {}); return row; }, 'Job'));
router.get('/scholarships', asyncHandler(async (req, res) => ok(res, await listings.listScholarships(req.query))));
router.get('/scholarships/:id', detail(listings.scholarshipDetail, 'Scholarship'));
router.get('/institutes', asyncHandler(async (req, res) => ok(res, await listings.listInstitutes(req.query))));
router.get('/institutes/:id', detail(listings.instituteDetail, 'Institute'));
router.get('/marketplace', asyncHandler(async (req, res) => ok(res, await listings.listProducts(req.query))));
router.get('/marketplace/:id', detail(listings.productDetail, 'Listing'));
router.get('/donors', asyncHandler(async (req, res) => ok(res, await listings.listDonors(req.query))));
router.get('/donors/:id', detail(listings.donorDetail, 'Donor'));

// Homepage sections beyond the listings (numbers, courses, teachers, employers, blog, programmes)
// and the homepage search's country/city/level options.
const homeSections = require('../services/publicHome.service');
router.get('/home/sections', asyncHandler(async (req, res) => ok(res, await homeSections.homeSections())));
router.get('/courses', asyncHandler(async (req, res) => ok(res, await homeSections.listCourses(req.query))));
router.get('/courses/:id', detail(homeSections.courseDetail, 'Course'));
router.get('/search-options', asyncHandler(async (req, res) => ok(res, await homeSections.searchOptions())));
router.get('/cities', asyncHandler(async (req, res) => ok(res, await homeSections.citiesFor(req.query.country))));

// A donor's own public profile settings (off until they switch it on).
const PROFILE_FIELDS = ['enabled', 'displayName', 'about', 'logoUrl', 'focusAreas', 'city', 'country', 'showScholarships'];
router.get('/me/donor-profile', protect, requireRole('donor'), asyncHandler(async (req, res) => {
  const row = await DonorPublicProfile.findOne({ user: req.user._id }).lean();
  return ok(res, row || { enabled: false, displayName: req.user.fullName, about: '', logoUrl: '', focusAreas: [], city: req.user.city || '', country: req.user.country || '', showScholarships: true });
}));
router.put('/me/donor-profile', protect, requireRole('donor'), asyncHandler(async (req, res) => {
  const update = Object.fromEntries(PROFILE_FIELDS.filter((f) => req.body[f] !== undefined).map((f) => [f, req.body[f]]));
  if (update.focusAreas !== undefined) update.focusAreas = (Array.isArray(update.focusAreas) ? update.focusAreas : String(update.focusAreas).split(',')).map((s) => String(s).trim()).filter(Boolean).slice(0, 8);
  if (update.enabled && !String(update.displayName ?? (await DonorPublicProfile.findOne({ user: req.user._id }))?.displayName ?? '').trim()) throw new AppError('Add a public name before publishing your profile.', 422);
  try {
    const row = await DonorPublicProfile.findOneAndUpdate({ user: req.user._id }, { $set: { ...update, user: req.user._id } }, { new: true, upsert: true, runValidators: true });
    listings.resetStatsCache();
    return ok(res, row, row.enabled ? 'Your public donor profile is live.' : 'Public donor profile saved (not visible).');
  } catch (e) {
    if (e.name === 'ValidationError') throw new AppError(Object.values(e.errors)[0]?.message || 'Check the profile details.', 422);
    throw e;
  }
}));

module.exports = router;
