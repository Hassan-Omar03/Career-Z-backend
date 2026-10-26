const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const Institution = require('../models/Institution');
const Job = require('../models/Job');
const User = require('../models/User');
const Scholarship = require('../models/Scholarship');
const ScholarshipApplication = require('../models/ScholarshipApplication');
const Sponsorship = require('../models/Sponsorship');
const TeacherProfile = require('../models/TeacherProfile');
const BlogPost = require('../models/BlogPost');
const Country = require('../models/Country');
const Setting = require('../models/Setting');
const listings = require('./publicListings.service');
const { VERIFIED_ROLES } = require('../config/accountVerification');

// The homepage sections that are not plain listings: platform numbers, courses, teachers,
// trainers, academies, employers, blog posts and the agent/donor programme figures. Every number
// is counted from the database under the same visibility rules as publicListings.service.js
// (active, verified publishers only); nothing is sample data.

const TRAINER_CATEGORIES = ['corporate_trainer', 'vocational_trainer'];
const ACADEMY_TYPES = ['academy', 'tuition_center', 'training_institute'];
const escape = (s) => String(s || '').slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const httpsImage = (u) => (/^https:\/\//.test(u || '') || /^data:image\//.test(u || '') ? u : null);

// Accounts that hold a role and (for verified roles) have it approved.
async function verifiedCount(role) {
  const ids = await User.distinct('_id', { status: 'active', roles: role });
  if (!VERIFIED_ROLES.includes(role)) return ids.length;
  return (await listings.eligiblePublishers(ids, role)).length;
}

// ---------------------------------------------------------------- courses
async function courseFilter(query = {}) {
  const and = [{ published: true, testOnly: { $ne: true } }];
  if (query.level && String(query.level).trim()) and.push({ level: new RegExp(`^${escape(query.level.trim())}$`, 'i') });
  if (['online', 'physical', 'hybrid', 'recorded', 'self_paced', 'ai'].includes(query.mode)) and.push({ studyMode: query.mode });
  if (query.price === 'free') and.push({ isFree: true });
  if (query.price === 'paid') and.push({ isFree: false });
  const words = String(query.q || '').split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
  for (const w of words) and.push({ $or: ['title', 'subject', 'category', 'description'].map((f) => ({ [f]: { $regex: escape(w), $options: 'i' } })) });
  // Courses of institutions only while that institution is active and verified.
  const verifiedInstitutions = await Institution.distinct('_id', { status: 'active', verificationStatus: 'approved' });
  and.push({ $or: [{ institution: null }, { institution: { $in: verifiedInstitutions } }] });
  if (query.country || query.city) {
    const place = { status: 'active', verificationStatus: 'approved' };
    if (query.country) place.country = new RegExp(`^${escape(query.country)}$`, 'i');
    if (query.city) place.city = new RegExp(escape(query.city), 'i');
    const ids = await Institution.distinct('_id', place);
    const teacherPlace = { status: 'active', roles: 'teacher' };
    if (query.country) teacherPlace.country = place.country;
    if (query.city) teacherPlace.city = place.city;
    const teachersThere = await User.distinct('_id', teacherPlace);
    and.push({ $or: [{ institution: { $in: ids } }, { institution: null, teacher: { $in: teachersThere } }] });
  }
  const teachers = await listings.eligiblePublishers(await Course.distinct('teacher', { $and: and }), 'teacher');
  return { $and: and, teacher: { $in: teachers } };
}

async function courseCards(rows) {
  const ids = rows.map((c) => c._id);
  const counts = ids.length ? await Enrollment.aggregate([{ $match: { course: { $in: ids }, status: { $ne: 'dropped' } } }, { $group: { _id: '$course', n: { $sum: 1 } } }]) : [];
  const enrolled = new Map(counts.map((c) => [String(c._id), c.n]));
  return rows.map((c) => ({
    _id: c._id, title: c.title, subject: c.subject || c.category || '', level: c.level || '', studyMode: c.studyMode, duration: c.duration || '',
    image: httpsImage(c.thumbnail) || httpsImage(c.coverImage),
    price: c.isFree || !(c.price > 0) ? null : c.price, currency: c.currency, isFree: Boolean(c.isFree) || !(c.price > 0),
    teacher: c.teacher ? { _id: c.teacher._id, name: c.teacher.fullName } : null,
    institution: c.institution ? { _id: c.institution._id, name: c.institution.name } : null,
    enrolled: enrolled.get(String(c._id)) || 0, postedAt: c.createdAt
  }));
}

async function listCourses(query = {}) {
  const limit = Math.min(48, Math.max(1, Number(query.limit) || 12));
  const page = Math.max(1, Math.min(500, Number(query.page) || 1));
  const filter = await courseFilter(query);
  const [rows, total] = await Promise.all([
    Course.find(filter).select('title subject category level studyMode duration thumbnail coverImage isFree price currency teacher institution createdAt')
      .populate('teacher', 'fullName').populate('institution', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Course.countDocuments(filter)
  ]);
  return { items: await courseCards(rows), total, page, pages: Math.ceil(total / limit) || 1 };
}

async function courseDetail(id) {
  const filter = await courseFilter({});
  const c = await Course.findOne({ ...filter, _id: id }).populate('teacher', 'fullName').populate('institution', 'name city').lean();
  if (!c) return null;
  const [card] = await courseCards([c]);
  const portfolio = await TeacherProfile.exists({ user: c.teacher?._id, publicPortfolio: true, status: 'active' });
  return { ...card, description: c.description || '', language: c.language, creditHours: c.creditHours, certificate: Boolean(c.certificateEnabled), teacherPortfolio: Boolean(portfolio), category: c.category || '', tags: c.tags || [] };
}

// ---------------------------------------------------------------- teachers and trainers
// Only teachers who chose to publish a public portfolio are featured.
async function featuredPeople(trainers, limit) {
  const filter = { publicPortfolio: true, status: 'active', categories: trainers ? { $in: TRAINER_CATEGORIES } : { $not: { $elemMatch: { $in: TRAINER_CATEGORIES } } } };
  const profiles = await TeacherProfile.find(filter).select('user subjects categories experienceYears').limit(60).lean();
  const allowed = new Set((await listings.eligiblePublishers(profiles.map((p) => p.user), 'teacher')).map(String));
  const visible = profiles.filter((p) => allowed.has(String(p.user)));
  const standing = require('./teacherStanding.service');
  const users = await User.find({ _id: { $in: visible.map((p) => p.user) } }).select('fullName profilePhoto city').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const cards = await Promise.all(visible.map(async (p) => {
    const s = await standing.standingFor(p.user);
    const u = byId.get(String(p.user));
    return {
      _id: p.user, name: u?.fullName || 'Teacher', photo: httpsImage(u?.profilePhoto), city: u?.city || '',
      role: (p.subjects || []).slice(0, 2).join(', ') || (p.categories || []).map((c) => c.replace(/_/g, ' ')).slice(0, 1).join('') || 'Teacher',
      experienceYears: p.experienceYears || 0, rating: s.reviews.average, ratings: s.reviews.count, studentsTaught: s.studentsTaught, badge: s.badge?.label || null
    };
  }));
  return cards.sort((a, b) => (b.studentsTaught - a.studentsTaught) || ((b.rating || 0) - (a.rating || 0)) || (b.experienceYears - a.experienceYears)).slice(0, limit);
}

// ---------------------------------------------------------------- employers (from open jobs)
async function featuredEmployers(limit) {
  const open = await listings.listJobs({ limit: 48 });
  const map = new Map();
  for (const j of open.items) {
    const key = String(j.company || '').trim();
    if (!key) continue;
    const row = map.get(key.toLowerCase()) || { name: key, logo: j.companyLogo || null, openJobs: 0, city: j.city || '' };
    row.openJobs += 1;
    map.set(key.toLowerCase(), row);
  }
  return [...map.values()].sort((a, b) => b.openJobs - a.openJobs).slice(0, limit);
}

// ---------------------------------------------------------------- blog
async function latestPosts(limit) {
  const posts = await BlogPost.find({ status: 'published' }).select('slug title excerpt category coverImage publishedAt createdAt content').sort({ publishedAt: -1 }).limit(limit).lean();
  return posts.map((p) => ({
    slug: p.slug, title: p.title, excerpt: p.excerpt || '', category: p.category || '', image: httpsImage(p.coverImage),
    publishedAt: p.publishedAt || p.createdAt, readMinutes: Math.max(1, Math.round(String(p.content || '').split(/\s+/).length / 200))
  }));
}

// ---------------------------------------------------------------- programme figures
async function programmes() {
  const [rateSetting, agents, sponsored, sponsoredStudents, donorScholarships] = await Promise.all([
    Setting.findOne({ key: 'commission_rate_percent' }).lean(),
    verifiedCount('education_agent'),
    Sponsorship.find({ status: { $in: ['active', 'completed'] } }).select('student scholarship').lean(),
    Sponsorship.distinct('student', { status: { $in: ['active', 'completed'] } }),
    Scholarship.distinct('donor').then((ids) => listings.eligiblePublishers(ids, 'donor')).then((ids) => Scholarship.countDocuments({ donor: { $in: ids } }))
  ]);
  const cities = sponsoredStudents.length ? (await User.distinct('city', { _id: { $in: sponsoredStudents }, city: { $nin: [null, ''] } })).map((c) => c.trim().toLowerCase()) : [];
  return {
    agent: { commissionRate: require('../utils/commissionSettings').asRate(rateSetting?.value), activeAgents: agents },
    donor: { studentsSponsored: sponsoredStudents.length, scholarshipsFunded: new Set(sponsored.map((s) => String(s.scholarship))).size, scholarshipsPublished: donorScholarships, citiesReached: new Set(cities).size }
  };
}

// ---------------------------------------------------------------- platform numbers
async function platformStats() {
  const [base, students, teachers, courses, employers, agents, instCities, userCities, awarded] = await Promise.all([
    listings.stats(),
    User.countDocuments({ status: 'active', roles: 'student' }),
    verifiedCount('teacher'),
    courseFilter({}).then((f) => Course.countDocuments(f)),
    verifiedCount('employer'),
    verifiedCount('education_agent'),
    Institution.distinct('city', { status: 'active', verificationStatus: 'approved', city: { $nin: [null, ''] } }),
    User.distinct('city', { status: 'active', city: { $nin: [null, ''] } }),
    ScholarshipApplication.countDocuments({ status: 'approved' })
  ]);
  const cities = new Set([...instCities, ...userCities].map((c) => String(c).trim().toLowerCase()).filter(Boolean)).size;
  return { ...base, students, teachers, courses, employers, educationAgents: agents, cities, scholarshipsAwarded: awarded };
}

// ---------------------------------------------------------------- search filters
// Countries and cities that actually have verified institutes or open jobs, so every option in
// the homepage search finds something.
async function searchOptions() {
  const [instCountries, jobCountries] = await Promise.all([
    Institution.distinct('country', { status: 'active', verificationStatus: 'approved' }),
    Job.distinct('country', { status: 'active' })
  ]);
  const codes = [...new Set([...instCountries, ...jobCountries].filter(Boolean).map((c) => String(c).toUpperCase()))];
  const known = await Country.find({ code: { $in: codes } }).select('code name').lean();
  const names = new Map(known.map((c) => [c.code, c.name]));
  const countries = codes.map((code) => ({ code, name: names.get(code) || code })).sort((a, b) => a.name.localeCompare(b.name));
  const levels = [...new Set((await Course.distinct('level', { published: true, testOnly: { $ne: true } })).map((l) => String(l || '').trim()).filter(Boolean))].sort();
  return { countries, courseLevels: levels };
}

async function citiesFor(country) {
  const code = String(country || '').trim();
  if (!code) return [];
  const re = new RegExp(`^${escape(code)}$`, 'i');
  const [a, b] = await Promise.all([
    Institution.distinct('city', { status: 'active', verificationStatus: 'approved', country: re }),
    Job.distinct('city', { status: 'active', country: re })
  ]);
  const seen = new Map();
  for (const c of [...a, ...b]) { const t = String(c || '').trim(); if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); }
  return [...seen.values()].sort((x, y) => x.localeCompare(y));
}

// ---------------------------------------------------------------- homepage bundle (cached briefly)
let cache = { at: 0, value: null };
async function homeSections() {
  if (cache.value && Date.now() - cache.at < 60 * 1000) return cache.value;
  const [stats, courses, teachers, trainers, academies, employers, blog, programmeFigures] = await Promise.all([
    platformStats(), listCourses({ limit: 8 }), featuredPeople(false, 4), featuredPeople(true, 4),
    Promise.all(ACADEMY_TYPES.map((type) => listings.listInstitutes({ type, limit: 4 }))).then((r) => r.flatMap((x) => x.items).slice(0, 4)),
    featuredEmployers(8), latestPosts(4), programmes()
  ]);
  cache = { at: Date.now(), value: { stats, courses: courses.items, teachers, trainers, academies, employers, blog, programmes: programmeFigures } };
  return cache.value;
}
const resetCache = () => { cache = { at: 0, value: null }; };

module.exports = { homeSections, listCourses, courseDetail, platformStats, searchOptions, citiesFor, resetCache, ACADEMY_TYPES };
