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
// Programs, levels open for admission, intakes, deadlines and subject groups (Point 22).
router.get('/institutes/:id/admission-options', asyncHandler(async (req, res) => {
  if (!require('mongoose').isValidObjectId(req.params.id)) return ok(res, []);
  const filter = await listings.instituteFilter({});
  const inst = await require('../models/Institution').findOne({ ...filter, _id: req.params.id }).select('name logo city country').lean();
  if (!inst) return ok(res, null);
  return ok(res, { institution: { _id: inst._id, name: inst.name, logo: /^https:\/\//.test(inst.logo || '') ? inst.logo : null, city: inst.city || '', country: inst.country || '' }, programs: await require('../services/admissionOptions.service').optionsFor(inst._id) });
}));
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

// Public Events page (audit N-30): upcoming and ongoing events that verified institutes chose to show.
router.get('/events', asyncHandler(async (req, res) => {
  const Institution = require('../models/Institution');
  const allowed = await Institution.find(await listings.instituteFilter({})).select('_id').lean();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await require('../models/InstitutionEvent').find({
    isPublic: true, institution: { $in: allowed.map((i) => i._id) }, status: { $in: ['upcoming', 'ongoing'] },
    $or: [{ endDate: { $gte: since } }, { endDate: null, startDate: { $gte: since } }]
  }).select('title type description startDate endDate venue coverImage institution').populate('institution', 'name city country slug').sort({ startDate: 1 }).limit(100).lean();
  return ok(res, rows.map((e) => ({ _id: e._id, title: e.title, type: e.type, description: String(e.description || '').slice(0, 400), startDate: e.startDate, endDate: e.endDate, venue: e.venue,
    institution: e.institution ? { name: e.institution.name, city: e.institution.city, country: e.institution.country, slug: e.institution.slug } : null })));
}));

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

// Contact page form (audit point 1). Open to visitors; limited per IP, with a hidden "website" field
// that people never fill but spam bots do.
const ENQUIRY_TYPES = ['support', 'partnership', 'institution', 'advertising', 'media', 'other'];
const contactLimit = require('express-rate-limit')({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'You have sent several messages already. Please try again in an hour, or email info@careerz.pk.' } });
router.post('/contact', contactLimit, asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (String(b.website || '').trim()) return ok(res, { received: true }, 'Thank you. Your message has been sent.');
  const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const name = text(b.name, 120), email = text(b.email, 200).toLowerCase(), message = String(b.message ?? '').trim().slice(0, 4000);
  const errors = {};
  if (name.length < 2) errors.name = 'Enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.';
  if (!ENQUIRY_TYPES.includes(b.enquiryType)) errors.enquiryType = 'Choose what your message is about.';
  if (message.length < 10) errors.message = 'Write your message (at least 10 characters).';
  if (Object.keys(errors).length) throw new AppError('Please fix the highlighted fields.', 422, { fields: errors });
  let user = null;
  try { const auth = String(req.headers.authorization || ''); if (auth.startsWith('Bearer ')) user = require('jsonwebtoken').verify(auth.slice(7), require('../config/env').jwt.accessSecret).sub || null; } catch { user = null; }
  const saved = await require('../models/ContactMessage').create({ name, email, message, enquiryType: b.enquiryType, phone: text(b.phone, 40), organization: text(b.organization, 160), user, ip: req.ip || '' });
  await require('../services/notification.service').notifyAdmins({
    title: `Contact form: ${b.enquiryType} enquiry from ${name}`,
    body: `${name} <${email}>${saved.phone ? ` · ${saved.phone}` : ''}${saved.organization ? ` · ${saved.organization}` : ''}\n\n${message}`,
    category: 'contact', link: '/dashboard'
  }).catch(() => {});
  return ok(res, { received: true }, 'Thank you. Your message has been sent. We usually reply within 1 to 2 working days.');
}));

module.exports = router;
