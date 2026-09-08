const Institution = require('../models/Institution');
const Campus = require('../models/Campus');
const ClassSection = require('../models/ClassSection');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// POST /api/institutions
const registerInstitution = asyncHandler(async (req, res) => {
  const { name, type, country, city, address, description, contactEmail, contactPhone, website } = req.body;
  if (!name || !type || !country) throw new AppError('Name, type and country are required.', 422);

  let slug = slugify(name);
  const clash = await Institution.findOne({ slug });
  if (clash) slug = `${slug}-${Date.now().toString(36)}`;

  const institution = await Institution.create({
    owner: req.user._id,
    name,
    slug,
    type,
    country,
    city,
    address,
    description,
    contactEmail,
    contactPhone,
    website
  });

  // Ensure the creator holds the institution_owner role.
  if (!req.user.roles.includes('institution_owner') && !req.user.roles.includes('academy_owner')) {
    req.user.roles.push('institution_owner');
    await req.user.save();
  }

  return created(res, institution, 'Institution registered. Submit documents for verification.');
});

// GET /api/institutions (public listing, approved + active only)
const listInstitutions = asyncHandler(async (req, res) => {
  const { country, type, q } = req.query;
  const filter = { status: 'active', verificationStatus: 'approved' };
  if (country) filter.country = country;
  if (type) filter.type = type;
  if (q) filter.name = { $regex: q, $options: 'i' };

  const institutions = await Institution.find(filter).select('-verificationDocuments -staff').sort({ name: 1 });
  return ok(res, institutions);
});

// GET /api/institutions/admin/all (admin/platform_staff — every status, for verification review)
const adminListAll = asyncHandler(async (req, res) => {
  const institutions = await Institution.find({}).select('-verificationDocuments -staff').sort({ createdAt: -1 });
  return ok(res, institutions);
});

// GET /api/institutions/mine (owner's institutions)
const myInstitutions = asyncHandler(async (req, res) => {
  const institutions = await Institution.find({
    $or: [{ owner: req.user._id }, { 'staff.user': req.user._id }]
  });
  return ok(res, institutions);
});

// GET /api/institutions/:id
const getInstitution = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id).populate('owner', 'fullName email');
  if (!institution) throw new AppError('Institution not found.', 404);
  return ok(res, institution);
});

function assertOwnerOrStaff(institution, userId) {
  const isOwner = institution.owner.toString() === userId.toString();
  const isStaff = institution.staff.some((s) => s.user.toString() === userId.toString());
  if (!isOwner && !isStaff) throw new AppError('You do not manage this institution.', 403);
  return isOwner;
}

// PATCH /api/institutions/:id
const updateInstitution = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const allowed = ['name', 'city', 'address', 'description', 'contactEmail', 'contactPhone', 'website', 'logo', 'coverImage'];
  allowed.forEach((field) => {
    if (req.body[field] !== undefined) institution[field] = req.body[field];
  });
  await institution.save();
  return ok(res, institution);
});

// POST /api/institutions/:id/verification-documents
const submitVerificationDocuments = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  if (institution.owner.toString() !== req.user._id.toString()) {
    throw new AppError('Only the owner can submit verification documents.', 403);
  }

  const { documents } = req.body; // array of file URLs
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new AppError('At least one document is required.', 422);
  }

  institution.verificationDocuments.push(...documents);
  institution.verificationStatus = 'under_review';
  await institution.save();

  return ok(res, institution, 'Documents submitted for review.');
});

// PATCH /api/institutions/:id/verify (admin/platform_staff)
const reviewVerification = asyncHandler(async (req, res) => {
  const { decision, notes } = req.body; // decision: 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) throw new AppError('Decision must be approved or rejected.', 422);

  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);

  institution.verificationStatus = decision;
  await institution.save();

  return ok(res, institution, `Institution verification ${decision}.`);
});

// POST /api/institutions/:id/staff
const addStaff = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = assertOwnerOrStaff(institution, req.user._id);
  if (!isOwner) throw new AppError('Only the owner can manage staff.', 403);

  const { userId, role, permissions } = req.body;
  if (!userId || !role) throw new AppError('userId and role are required.', 422);

  const alreadyStaff = institution.staff.some((s) => s.user.toString() === userId);
  if (alreadyStaff) throw new AppError('User is already staff at this institution.', 409);

  institution.staff.push({ user: userId, role, permissions: permissions || [] });
  await institution.save();

  const User = require('../models/User');
  const staffUser = await User.findById(userId);
  if (staffUser && !staffUser.roles.includes('institution_staff')) {
    staffUser.roles.push('institution_staff');
    await staffUser.save();
  }

  return ok(res, institution, 'Staff member added.');
});

// DELETE /api/institutions/:id/staff/:userId
const removeStaff = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  const isOwner = assertOwnerOrStaff(institution, req.user._id);
  if (!isOwner) throw new AppError('Only the owner can manage staff.', 403);

  institution.staff = institution.staff.filter((s) => s.user.toString() !== req.params.userId);
  await institution.save();
  return ok(res, institution, 'Staff member removed.');
});

// ---- Campuses ----
const createCampus = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const campus = await Campus.create({ institution: institution._id, ...req.body });
  return created(res, campus);
});

const listCampuses = asyncHandler(async (req, res) => {
  const campuses = await Campus.find({ institution: req.params.id });
  return ok(res, campuses);
});

// ---- Class Sections ----
const createClassSection = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrStaff(institution, req.user._id);

  const section = await ClassSection.create({ institution: institution._id, ...req.body });
  return created(res, section);
});

const listClassSections = asyncHandler(async (req, res) => {
  const sections = await ClassSection.find({ institution: req.params.id });
  return ok(res, sections);
});

module.exports = {
  registerInstitution,
  listInstitutions,
  myInstitutions,
  getInstitution,
  updateInstitution,
  submitVerificationDocuments,
  reviewVerification,
  adminListAll,
  addStaff,
  removeStaff,
  createCampus,
  listCampuses,
  createClassSection,
  listClassSections
};
