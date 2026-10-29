const Job = require('../models/Job');
const Scholarship = require('../models/Scholarship');
const Institution = require('../models/Institution');
const InstitutionProgram = require('../models/InstitutionProgram');
const Product = require('../models/Product');
const Course = require('../models/Course');
const User = require('../models/User');
const RoleRequest = require('../models/RoleRequest');
const DonorPublicProfile = require('../models/DonorPublicProfile');
const { VERIFIED_ROLES } = require('../config/accountVerification');

// Everything the public homepage and its "View All" pages show, from the database, under one
// set of visibility rules:
//   - the publisher's account is active and, for verified roles, approved for that role;
//   - the record itself is published/approved, not expired, closed, suspended or rejected;
//   - only public fields leave the server (never emails, phone numbers, documents or finances).

const PAGE_MAX = 48;
const escape = (s) => String(s || '').slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (q) => String(q || '').split(/\s+/).map((w) => w.trim()).filter((w) => w.length > 1).slice(0, 6);
const textMatch = (q, fields) => {
  const list = words(q);
  return list.length ? { $and: list.map((w) => ({ $or: fields.map((f) => ({ [f]: { $regex: escape(w), $options: 'i' } })) })) } : {};
};
const exact = (v) => (typeof v === 'string' && v.trim() ? new RegExp(`^${escape(v.trim())}$`, 'i') : null);
const contains = (v) => (typeof v === 'string' && v.trim() ? new RegExp(escape(v.trim()), 'i') : null);
const num = (v) => (v === undefined || v === '' || v === null || Number.isNaN(Number(v)) ? null : Number(v));
const paging = (query) => {
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(query.limit) || 12));
  const page = Math.max(1, Math.min(500, Number(query.page) || 1));
  return { limit, page, skip: (page - 1) * limit };
};

// Publishers whose account may show content publicly: active, holding the role, and (for roles in
// the verification programme) with that role's latest request approved.
async function eligiblePublishers(ids, role) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return [];
  const users = await User.find({ _id: { $in: unique }, status: 'active', roles: role }).select('_id').lean();
  if (!VERIFIED_ROLES.includes(role)) return users.map((u) => u._id);
  const requests = await RoleRequest.find({ user: { $in: users.map((u) => u._id) }, requestedRole: role }).select('user status createdAt').sort({ createdAt: -1 }).lean();
  const latest = new Map();
  for (const r of requests) if (!latest.has(String(r.user))) latest.set(String(r.user), r.status);
  return users.filter((u) => latest.get(String(u._id)) === 'approved').map((u) => u._id);
}

// Jobs are posted by verified employers and education agents, or by a verified, active institute
// for its own vacancies (whoever on its staff pressed Post).
async function jobPublishers(base) {
  const posters = await Job.distinct('postedBy', { $and: [base, { institution: null }] });
  const [agents, employers] = await Promise.all([eligiblePublishers(posters, 'education_agent'), eligiblePublishers(posters, 'employer')]);
  return [...agents, ...employers];
}
const verifiedInstitutionIds = () => Institution.distinct('_id', { status: 'active', verificationStatus: 'approved' });

const openDeadline = () => ({ $or: [{ applicationDeadline: null }, { applicationDeadline: { $exists: false } }, { applicationDeadline: { $gte: new Date() } }] });

// ---------------------------------------------------------------- jobs
const JOB_TYPES = ['full_time', 'part_time', 'internship', 'freelance', 'government', 'ngo'];
const { JOB_CATEGORIES } = require('../models/Job');
async function jobFilter(query = {}) {
  const base = { status: 'active', ...openDeadline() };
  const and = [base];
  if (exact(query.country)) and.push({ country: exact(query.country) });
  if (contains(query.city)) and.push({ city: contains(query.city) });
  if (JOB_TYPES.includes(query.type)) and.push({ type: query.type });
  if (['onsite', 'remote', 'hybrid'].includes(query.workMode)) and.push({ workMode: query.workMode });
  if (num(query.maxExperience) !== null) and.push({ experienceYears: { $lte: num(query.maxExperience) } });
  if (num(query.minSalary) !== null) and.push({ $or: [{ salaryMax: { $gte: num(query.minSalary) } }, { salaryMin: { $gte: num(query.minSalary) } }] });
  if (JOB_CATEGORIES.includes(query.category)) and.push({ category: query.category });
  if (query.q) and.push(textMatch(query.q, ['title', 'company', 'skills', 'description', 'city']));
  const [publishers, institutions] = await Promise.all([jobPublishers({ $and: and }), verifiedInstitutionIds()]);
  return { $and: [...and, { $or: [{ institution: null, postedBy: { $in: publishers } }, { institution: { $in: institutions } }] }] };
}
function jobCard(j, publisherRoles = new Map()) {
  return {
    _id: j._id, title: j.title, company: j.company, type: j.type, workMode: j.workMode, city: j.city || '', country: j.country,
    salaryMin: j.salaryMin, salaryMax: j.salaryMax, currency: j.currency, experienceYears: j.experienceYears || 0,
    applicationDeadline: j.applicationDeadline, postedAt: j.createdAt, featured: !!j.featured, visaSponsorship: !!j.visaSponsorship,
    sponsored: !!j.sponsored, urgent: !!j.urgent, topHiring: !j.institution && Boolean(j.postedBy && publisherRoles.topHiring?.has(String(j.postedBy._id))), vacancies: j.vacancies || 1,
    companyLogo: /^https:\/\//.test(j.companyLogo || '') ? j.companyLogo : null,
    category: j.category || 'other', institution: j.institution ? String(j.institution._id || j.institution) : null,
    postedBy: j.institution ? { name: j.company, kind: 'institute' } : j.postedBy ? { name: j.postedBy.fullName, kind: publisherRoles.get(String(j.postedBy._id)) || 'employer' } : null,
    verifiedPublisher: true
  };
}
async function publisherKinds(rows, field) {
  const ids = rows.map((r) => r[field]?._id).filter(Boolean);
  const users = await User.find({ _id: { $in: ids } }).select('roles employerPerks.topHiringUntil').lean();
  const map = new Map(users.map((u) => [String(u._id), u.roles.includes('education_agent') ? 'agent' : 'employer']));
  map.topHiring = new Set(users.filter((u) => u.employerPerks?.topHiringUntil && new Date(u.employerPerks.topHiringUntil) > new Date()).map((u) => String(u._id)));
  return map;
}
async function listJobs(query = {}) {
  const { limit, page, skip } = paging(query);
  const now = new Date();
  await Promise.all([
    Job.updateMany({ sponsored: true, sponsoredUntil: { $lt: now } }, { $set: { sponsored: false } }),
    Job.updateMany({ urgent: true, urgentUntil: { $lt: now } }, { $set: { urgent: false } })
  ]);
  const filter = await jobFilter(query);
  const [rows, total] = await Promise.all([
    Job.find(filter).populate('postedBy', 'fullName').sort({ featured: -1, sponsored: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    Job.countDocuments(filter)
  ]);
  const kinds = await publisherKinds(rows, 'postedBy');
  return { items: rows.map((r) => jobCard(r, kinds)), total, page, pages: Math.ceil(total / limit) || 1 };
}
async function jobDetail(id) {
  const filter = await jobFilter({});
  const job = await Job.findOne({ ...filter, _id: id }).populate('postedBy', 'fullName').lean();
  if (!job) return null;
  const kinds = await publisherKinds([job], 'postedBy');
  return { ...jobCard(job, kinds), employerId: !job.institution && job.postedBy ? job.postedBy._id : null, description: job.description || '', skills: job.skills || [], education: job.education || '', isGovernment: !!job.isGovernment };
}

// ---------------------------------------------------------------- scholarships (posted by donors)
async function scholarshipFilter(query = {}) {
  const and = [{ status: 'open', seatsAvailable: { $gt: 0 } }, openDeadline()];
  if (exact(query.country)) and.push({ country: exact(query.country) });
  if (num(query.minAmount) !== null) and.push({ amount: { $gte: num(query.minAmount) } });
  if (query.deadlineBefore && !Number.isNaN(Date.parse(query.deadlineBefore))) and.push({ applicationDeadline: { $lte: new Date(query.deadlineBefore) } });
  if (query.q) and.push(textMatch(query.q, ['title', 'description', 'eligibilityCriteria', 'country']));
  const donors = await eligiblePublishers(await Scholarship.distinct('donor', { $and: and }), 'donor');
  // Agent listings: admin-approved, the agent still verified, and a donor provider still verified.
  const agents = await eligiblePublishers(await Scholarship.distinct('publishedBy', { $and: [...and, { publishedBy: { $ne: null } }] }), 'education_agent');
  return { $and: [...and, { $or: [
    { publishedBy: null, donor: { $in: donors } },
    { publishedBy: { $in: agents }, 'review.status': 'approved', $or: [{ donor: null, applicationMode: 'external' }, { donor: { $in: donors } }] }
  ] }] };
}
async function donorNames(rows) {
  const ids = rows.map((r) => r.donor?._id || r.donor).filter(Boolean);
  const profiles = await DonorPublicProfile.find({ user: { $in: ids }, enabled: true }).select('user displayName').lean();
  return new Map(profiles.map((p) => [String(p.user), p.displayName]));
}
function scholarshipCard(s, names) {
  const donorId = String(s.donor?._id || s.donor);
  const publicName = names.get(donorId);
  return {
    _id: s._id, title: s.title, amount: s.amount, currency: s.currency, country: s.country || '', applicationDeadline: s.applicationDeadline,
    seatsAvailable: s.seatsAvailable, eligibility: String(s.eligibilityCriteria || '').slice(0, 220), postedAt: s.createdAt,
    // A donor's name is shown only when they published a public profile; otherwise "Verified donor".
    // An agent listing names its provider; an outside provider's listing applies on their site.
    provider: s.publishedBy && !s.donor ? { name: s.provider?.name || 'Provider', profile: null, website: s.provider?.website || '' }
      : publicName ? { name: publicName, profile: `/donors/${donorId}` } : { name: s.publishedBy ? s.provider?.name || 'Verified donor' : 'Verified donor', profile: null },
    applicationMode: s.applicationMode || 'internal', externalUrl: s.applicationMode === 'external' ? s.externalUrl : null, listedByAgent: Boolean(s.publishedBy)
  };
}
async function listScholarships(query = {}) {
  const { limit, page, skip } = paging(query);
  const filter = await scholarshipFilter(query);
  const [rows, total] = await Promise.all([Scholarship.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), Scholarship.countDocuments(filter)]);
  const names = await donorNames(rows);
  return { items: rows.map((r) => scholarshipCard(r, names)), total, page, pages: Math.ceil(total / limit) || 1 };
}
async function scholarshipDetail(id) {
  const filter = await scholarshipFilter({});
  const s = await Scholarship.findOne({ ...filter, _id: id }).lean();
  if (!s) return null;
  const names = await donorNames([s]);
  return { ...scholarshipCard(s, names), description: s.description || '', eligibility: s.eligibilityCriteria || '' };
}

// ---------------------------------------------------------------- institutes
const INSTITUTE_TYPES = ['school', 'college', 'university', 'academy', 'madrasa', 'tuition_center', 'training_institute', 'online_institute'];
async function instituteFilter(query = {}) {
  const and = [{ status: 'active', verificationStatus: 'approved' }];
  if (exact(query.country)) and.push({ country: exact(query.country) });
  if (contains(query.city)) and.push({ city: contains(query.city) });
  if (INSTITUTE_TYPES.includes(query.type)) and.push({ type: query.type });
  if (query.q) and.push(textMatch(query.q, ['name', 'description', 'city']));
  const owners = await eligiblePublishers(await Institution.distinct('owner', { $and: and }), 'institution_owner');
  const academyOwners = await eligiblePublishers(await Institution.distinct('owner', { $and: and }), 'academy_owner');
  return { $and: and, owner: { $in: [...owners, ...academyOwners] } };
}
const instituteCard = (i, programs = []) => ({
  _id: i._id, name: i.name, type: i.type, city: i.city || '', country: i.country, logo: /^https:\/\//.test(i.logo || '') || /^data:image\//.test(i.logo || '') ? i.logo : null,
  description: String(i.description || '').slice(0, 220), programs: programs.slice(0, 4), verified: true
});
async function programNames(ids) {
  const rows = await InstitutionProgram.find({ institution: { $in: ids }, active: { $ne: false } }).select('institution name').lean();
  const map = new Map();
  for (const r of rows) { const k = String(r.institution); map.set(k, [...(map.get(k) || []), r.name]); }
  return map;
}
async function listInstitutes(query = {}) {
  const { limit, page, skip } = paging(query);
  const filter = await instituteFilter(query);
  const [rows, total] = await Promise.all([Institution.find(filter).select('name type city country logo description').sort({ name: 1 }).skip(skip).limit(limit).lean(), Institution.countDocuments(filter)]);
  const programs = await programNames(rows.map((r) => r._id));
  return { items: rows.map((r) => instituteCard(r, programs.get(String(r._id)) || [])), total, page, pages: Math.ceil(total / limit) || 1 };
}
async function instituteDetail(id) {
  const filter = await instituteFilter({});
  const i = await Institution.findOne({ ...filter, _id: id }).select('name type city country logo coverImage description website owner address accreditations affiliations socialLinks location').lean();
  if (!i) return null;
  const openJobs = await jobFilter({});
  const [programs, courses, jobs, settings] = await Promise.all([
    InstitutionProgram.find({ institution: i._id, active: { $ne: false } }).select('name department durationTerms totalTuitionFee currency admissionFee').lean(),
    Course.find({ institution: i._id, published: true, testOnly: { $ne: true } }).select('title subject level isFree price currency').limit(24).lean(),
    // Jobs the institute itself posted (through its owner's employer account), if any.
    Job.find({ $and: [openJobs, { $or: [{ institution: i._id }, { institution: null, postedBy: i.owner }] }] }).select('title type city country applicationDeadline createdAt').limit(6).lean(),
    require('../models/InstitutionSettings').findOne({ institution: i._id }).select('subdomain').lean().catch(() => null)
  ]);
  return {
    ...instituteCard(i, programs.map((p) => p.name)), ...require('../utils/institutionProfile').publicProfileExtras(i), description: i.description || '', website: /^https?:\/\//.test(i.website || '') ? i.website : '',
    coverImage: /^https:\/\//.test(i.coverImage || '') ? i.coverImage : null,
    programs: programs.map((p) => ({ name: p.name, department: p.department, durationTerms: p.durationTerms, tuition: p.totalTuitionFee, admissionFee: p.admissionFee, currency: p.currency })),
    courses: courses.map((c) => ({ _id: c._id, title: c.title, subject: c.subject, level: c.level, price: c.isFree ? 'Free' : `${c.currency || ''} ${c.price || ''}`.trim() })),
    jobs: jobs.map((j) => ({ _id: j._id, title: j.title, type: j.type, location: [j.city, j.country].filter(Boolean).join(', '), applicationDeadline: j.applicationDeadline })),
    website_page: settings?.subdomain ? `/i/${settings.subdomain}` : null
  };
}

// ---------------------------------------------------------------- marketplace
const PRODUCT_CATEGORIES = ['books', 'stationery', 'uniform', 'electronics', 'courses', 'services', 'other'];
async function productFilter(query = {}) {
  const and = [{ status: 'active', $or: [{ stock: { $gt: 0 } }, { category: { $in: ['courses', 'services', 'notes'] } }, { 'digital.file': { $ne: null } }] }];
  if (PRODUCT_CATEGORIES.includes(query.category)) and.push({ category: query.category });
  if (num(query.minPrice) !== null) and.push({ price: { $gte: num(query.minPrice) } });
  if (num(query.maxPrice) !== null) and.push({ price: { $lte: num(query.maxPrice) } });
  if (query.q) and.push(textMatch(query.q, ['title', 'description', 'category']));
  const posters = await Product.distinct('seller', { $and: and });
  // Verified sellers, and verified students (who may sell in the student marketplace).
  const sellers = [...await eligiblePublishers(posters, 'marketplace_seller'), ...await eligiblePublishers(posters, 'student')];
  return { $and: and, seller: { $in: sellers } };
}
const productCard = (p) => ({
  _id: p._id, title: p.title, category: p.category, price: p.price, currency: p.currency, stock: p.stock,
  image: (p.images || []).find((u) => /^https:\/\//.test(u) || /^data:image\//.test(u)) || null,
  description: String(p.description || '').slice(0, 200), seller: p.seller ? { name: p.seller.fullName, city: p.seller.city || '' } : null, postedAt: p.createdAt
});
async function listProducts(query = {}) {
  const { limit, page, skip } = paging(query);
  const filter = await productFilter(query);
  const sort = query.sort === 'price_asc' ? { price: 1 } : query.sort === 'price_desc' ? { price: -1 } : { createdAt: -1 };
  const [rows, total] = await Promise.all([Product.find(filter).populate('seller', 'fullName city').sort(sort).skip(skip).limit(limit).lean(), Product.countDocuments(filter)]);
  return { items: rows.map(productCard), total, page, pages: Math.ceil(total / limit) || 1 };
}
async function productDetail(id) {
  const filter = await productFilter({});
  const p = await Product.findOne({ ...filter, _id: id }).populate('seller', 'fullName city').lean();
  return p ? { ...productCard(p), sellerId: p.seller?._id || null, digital: p.digital?.file ? { pages: p.digital.pages || 0, access: p.digital.access || 'download' } : null, description: p.description || '', images: (p.images || []).filter((u) => /^https:\/\//.test(u) || /^data:image\//.test(u)).slice(0, 6) } : null;
}

// ---------------------------------------------------------------- donors (opt-in public profiles)
async function donorFilter(query = {}) {
  const and = [{ enabled: true }];
  if (contains(query.country)) and.push({ country: contains(query.country) });
  if (contains(query.city)) and.push({ city: contains(query.city) });
  if (query.q) and.push(textMatch(query.q, ['displayName', 'about', 'focusAreas', 'city']));
  const donors = await eligiblePublishers(await DonorPublicProfile.distinct('user', { $and: and }), 'donor');
  return { $and: and, user: { $in: donors } };
}
async function donorCard(p) {
  const user = await User.findById(p.user).select('donorType').lean();
  const openScholarships = p.showScholarships ? await Scholarship.countDocuments({ ...(await scholarshipFilter({})), donor: p.user }) : 0;
  return {
    _id: p.user, name: p.displayName, type: user?.donorType === 'organization' ? 'Organization' : 'Individual donor', city: p.city, country: p.country,
    logo: p.logoUrl || null, about: String(p.about || '').slice(0, 220), focusAreas: p.focusAreas || [], openScholarships, verified: true
  };
}
async function listDonors(query = {}) {
  const { limit, page, skip } = paging(query);
  const filter = await donorFilter(query);
  const [rows, total] = await Promise.all([DonorPublicProfile.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(), DonorPublicProfile.countDocuments(filter)]);
  return { items: await Promise.all(rows.map(donorCard)), total, page, pages: Math.ceil(total / limit) || 1 };
}
async function donorDetail(id) {
  const filter = await donorFilter({});
  const p = await DonorPublicProfile.findOne({ ...filter, user: id }).lean();
  if (!p) return null;
  const card = await donorCard(p);
  const open = await scholarshipFilter({});
  const own = p.showScholarships ? await Scholarship.find({ $and: [open, { donor: p.user }] }).sort({ createdAt: -1 }).limit(24).lean() : [];
  const names = await donorNames(own);
  return { ...card, about: p.about || '', scholarships: own.map((s) => scholarshipCard(s, names)) };
}

// ---------------------------------------------------------------- statistics (cached briefly)
let statsCache = { at: 0, value: null };
async function stats() {
  if (statsCache.value && Date.now() - statsCache.at < 60 * 1000) return statsCache.value;
  const [jobs, scholarships, institutes, products, donors, users] = await Promise.all([
    jobFilter({}).then((f) => Job.countDocuments(f)), scholarshipFilter({}).then((f) => Scholarship.countDocuments(f)),
    instituteFilter({}).then((f) => Institution.countDocuments(f)), productFilter({}).then((f) => Product.countDocuments(f)),
    donorFilter({}).then((f) => DonorPublicProfile.countDocuments(f)), User.countDocuments({ status: 'active' })
  ]);
  statsCache = { at: Date.now(), value: { activeJobs: jobs, activeScholarships: scholarships, approvedInstitutes: institutes, activeMarketplaceListings: products, publicDonors: donors, registeredUsers: users, asOf: new Date() } };
  return statsCache.value;
}
const resetStatsCache = () => { statsCache = { at: 0, value: null }; };

async function home() {
  const [s, jobs, scholarships, institutes, products, donors] = await Promise.all([
    stats(), listJobs({ limit: 8 }), listScholarships({ limit: 8 }), listInstitutes({ limit: 8 }), listProducts({ limit: 8 }), listDonors({ limit: 8 })
  ]);
  return { stats: s, jobs: jobs.items, scholarships: scholarships.items, institutes: institutes.items, marketplace: products.items, donors: donors.items };
}

module.exports = {
  home, stats, resetStatsCache, listJobs, jobDetail, listScholarships, scholarshipDetail, listInstitutes, instituteDetail,
  listProducts, productDetail, listDonors, donorDetail, eligiblePublishers, JOB_TYPES, JOB_CATEGORIES, INSTITUTE_TYPES, PRODUCT_CATEGORIES
};
