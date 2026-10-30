const Scholarship = require('../models/Scholarship');
const mongoose = require('mongoose');
const ScholarshipApplication = require('../models/ScholarshipApplication');
const Sponsorship = require('../models/Sponsorship');
const DonorDeposit = require('../models/DonorDeposit');
const StudentProfile = require('../models/StudentProfile');
const Notification = require('../models/Notification');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { isRoleVerified } = require('../utils/roleVerification');
const { notify } = require('../services/notification.service');
const { generateTransactionId } = require('../utils/transactionId');
const { PAYMENT_METHOD_LABEL } = require('../utils/paymentMethods');

function assertOwnsScholarship(scholarship, userId) {
  if (String(scholarship.donor) !== String(userId)) {
    throw new AppError('You did not create this scholarship.', 403);
  }
}

// POST /api/scholarships
const APPLY = require('../config/scholarshipApplication');
// The donor's document list: known keys only, plus up to 5 named extra documents.
function cleanDocuments(body) {
  const out = {};
  if (body.requiredDocuments !== undefined) out.requiredDocuments = [...new Set([].concat(body.requiredDocuments || []).filter((k) => APPLY.DOCUMENT_KEYS.includes(k)))];
  if (body.otherDocuments !== undefined) out.otherDocuments = [...new Set([].concat(body.otherDocuments || []).map((s) => String(s || '').trim().slice(0, 80)).filter(Boolean))].slice(0, 5);
  return out;
}
const docListOf = (s) => [
  ...(s.requiredDocuments || []).map((k) => ({ key: k, label: APPLY.DOCUMENTS.find((d) => d.key === k)?.label || k })),
  ...(s.otherDocuments || []).map((label, i) => ({ key: `other_${i}`, label }))
];

const createScholarship = asyncHandler(async (req, res) => {
  if (!(await isRoleVerified(req.user._id, 'donor'))) {
    throw new AppError('Your Donor account is pending Super Admin verification. You can browse the dashboard but cannot post a scholarship until it is approved.', 403);
  }

  const allowed = [
    'title', 'description', 'amount', 'currency', 'eligibilityCriteria',
    'country', 'applicationDeadline', 'seatsAvailable', 'audience'
  ];
  const body = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) body[f] = req.body[f]; });
  Object.assign(body, cleanDocuments(req.body));
  if (!body.title || body.amount === undefined) {
    throw new AppError('title and amount are required.', 422);
  }
  if (body.audience !== undefined) {
    body.audience = [...new Set((Array.isArray(body.audience) ? body.audience : [body.audience]).filter((a) => ['students', 'teachers'].includes(a)))];
    if (!body.audience.length) body.audience = ['students'];
  }

  const scholarship = await Scholarship.create({ ...body, donor: req.user._id });
  // Verified donor + open scholarship = published: the people it is for get one alert.
  await require('../services/scholarshipAlerts.service').onScholarshipPublished(scholarship);
  return created(res, scholarship, 'Scholarship posted.');
});

// GET /api/scholarships (public browse)
const listScholarships = asyncHandler(async (req, res) => {
  const { country } = req.query;
  const filter = { status: 'open' };
  if (country) filter.country = country;
  const scholarships = await Scholarship.find(filter).populate('donor', 'fullName').sort({ createdAt: -1 }).limit(100);
  return ok(res, scholarships);
});

// GET /api/scholarships/:id
const getScholarship = asyncHandler(async (req, res) => {
  const scholarship = await Scholarship.findById(req.params.id).populate('donor', 'fullName');
  if (!scholarship) throw new AppError('Scholarship not found.', 404);
  return ok(res, scholarship);
});

// GET /api/scholarships/mine/list
const myScholarships = asyncHandler(async (req, res) => {
  const scholarships = await Scholarship.find({ donor: req.user._id }).sort({ createdAt: -1 });
  return ok(res, scholarships);
});

// PATCH /api/scholarships/:id
const updateScholarship = asyncHandler(async (req, res) => {
  const scholarship = await Scholarship.findById(req.params.id);
  if (!scholarship) throw new AppError('Scholarship not found.', 404);
  assertOwnsScholarship(scholarship, req.user._id);
  if (scholarship.status === 'removed_by_admin') throw new AppError(`CareerZ admin removed this: ${scholarship.adminRemoval?.reason || 'it broke the rules'}. Contact support if you think this is wrong.`, 403);

  const allowed = [
    'title', 'description', 'amount', 'currency', 'eligibilityCriteria',
    'country', 'applicationDeadline', 'seatsAvailable', 'status'
  ];
  if (req.body.requiredDocuments !== undefined || req.body.otherDocuments !== undefined) Object.assign(scholarship, cleanDocuments(req.body));
  // An agent listing goes live only through admin review; its donor may close it, not open it.
  if (scholarship.publishedBy && req.body.status !== undefined && req.body.status !== 'closed') throw new AppError('An agent listing is opened by admin review. You can close it.', 409);
  if (!['open', 'closed', undefined].includes(req.body.status)) throw new AppError('Invalid status.', 422);
  allowed.forEach((f) => { if (req.body[f] !== undefined) scholarship[f] = req.body[f]; });
  await scholarship.save();
  return ok(res, scholarship);
});

// POST /api/scholarships/:id/apply
const applyToScholarship = asyncHandler(async (req, res) => {
  const scholarship = await Scholarship.findById(req.params.id);
  if (!scholarship) throw new AppError('Scholarship not found.', 404);
  if (scholarship.status !== 'open') throw new AppError('This scholarship is closed.', 400);
  if (scholarship.applicationMode === 'external') throw new AppError('Apply on the provider\'s own website for this scholarship.', 400, { externalUrl: scholarship.externalUrl });
  if (scholarship.applicationDeadline && new Date(scholarship.applicationDeadline) < new Date()) throw new AppError('The application deadline has passed.', 400);
  if (!(scholarship.seatsAvailable > 0)) throw new AppError('All seats for this scholarship are filled.', 400);
  const roles = req.accessibleRoles || req.user.roles || [];
  // Students, and teachers when the publisher opened it to teachers (audience).
  const audience = scholarship.audience?.length ? scholarship.audience : ['students'];
  const eligible = [...(audience.includes('students') ? ['student'] : []), ...(audience.includes('teachers') ? ['teacher'] : [])];
  if (!eligible.some((r) => roles.includes(r))) {
    throw new AppError(eligible.includes('teacher') ? 'Only student and teacher accounts can apply for this scholarship.' : 'Only student accounts can apply for scholarships. Sign in with a student account, or create one.', 403, { code: 'WRONG_ACCOUNT_TYPE', eligible });
  }
  // The donor must still be allowed to list it (approved and active).
  if (!(await require('../services/publicListings.service').scholarshipDetail(scholarship._id))) throw new AppError('This scholarship is no longer accepting applications.', 400);
  if (!req.user.emailVerified) throw new AppError('Verify your email before applying to a scholarship (Profile tab).', 403);

  const existing = await ScholarshipApplication.findOne({ scholarship: scholarship._id, applicant: req.user._id });
  if (existing) throw new AppError('You already applied to this scholarship.', 409);

  // The application form, the reason for applying and each document the donor asked for.
  const errors = {};
  const form = {};
  const input = req.body.form || {};
  for (const f of APPLY.FIELDS) {
    const v = String(input[f.key] ?? '').trim().slice(0, f.type === 'textarea' ? 500 : 120);
    if (f.required && !v) { errors[f.key] = 'Required'; continue; }
    if (v && f.pattern === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) errors[f.key] = 'Enter a valid email';
    if (v && f.pattern === 'phone' && !/^\+?\d[\d\s-]{8,16}\d$/.test(v)) errors[f.key] = 'Enter a valid phone number';
    if (v && f.pattern === 'cnic' && !/^\d{5}-?\d{7}-?\d$/.test(v)) errors[f.key] = 'Use 13 digits, e.g. 35202-1234567-1';
    if (v && f.pattern === 'number' && !(Number(v) >= 0)) errors[f.key] = 'Enter a number';
    if (v && f.type === 'select' && !f.options.includes(v)) errors[f.key] = 'Choose one of the options';
    if (v) form[f.key] = v;
  }
  if (Object.keys(errors).length) throw new AppError('Complete the application form.', 422, errors);
  const reason = String(req.body.reason || req.body.statement || '').trim().slice(0, 3000);
  if (reason.length < APPLY.REASON_MIN) throw new AppError(`Explain why you are applying (at least ${APPLY.REASON_MIN} characters).`, 422);
  const wanted = docListOf(scholarship);
  const given = Array.isArray(req.body.documents) ? req.body.documents : [];
  const PrivateFile = require('../models/PrivateFile');
  const documents = [];
  for (const d of wanted) {
    const g = given.find((x) => x?.key === d.key);
    const file = g?.fileId && require('mongoose').isValidObjectId(g.fileId) ? await PrivateFile.findOne({ _id: g.fileId, owner: req.user._id, purpose: 'scholarship_document' }).select('filename') : null;
    if (!file) throw new AppError(`Upload: ${d.label}.`, 422);
    documents.push({ key: d.key, label: d.label, file: file._id, name: file.filename });
  }

  const application = await ScholarshipApplication.create({
    scholarship: scholarship._id,
    applicant: req.user._id,
    statement: reason,
    form,
    documents
  });
  // The donor hears about it.
  if (scholarship.donor) await require('../services/notification.service').notify(scholarship.donor, { title: `New scholarship application: ${scholarship.title}`, body: `${form.fullName} (${form.currentDegree}, ${form.city}) applied.`, link: '/dashboard?tab=scholarships' }).catch(() => {});

  return created(res, application, 'Application submitted.');
});

// GET /api/scholarships/mine/applications (as applicant)
// GET /api/scholarships/:id/apply-form — the form, the requested documents and what the profile
// already knows (prefilled).
const applyForm = asyncHandler(async (req, res) => {
  const scholarship = await Scholarship.findById(req.params.id).select('title requiredDocuments otherDocuments status');
  if (!scholarship) throw new AppError('Scholarship not found.', 404);
  const profile = await require('../models/UserProfile').findOne({ user: req.user._id, role: { $in: ['student', 'teacher'] } }).select('fields').lean();
  const p = profile?.fields || {};
  const prefill = {
    fullName: req.user.fullName || p.fullName || '', fatherName: p.fatherName || '', dateOfBirth: p.dateOfBirth ? String(p.dateOfBirth).slice(0, 10) : '', gender: p.gender || '',
    phone: req.user.phone || p.contactNumber || '', email: req.user.email || '', address: p.address || '', city: p.city || req.user.city || '', province: p.province || '', country: p.country || req.user.country || 'Pakistan',
    currentInstitution: p.institutionName || p.currentInstitution || '', currentDegree: p.degreeTitle || p.currentDegree || '', lastDegree: p.highestQualification || ''
  };
  return ok(res, { fields: APPLY.FIELDS, documents: docListOf(scholarship), reasonMin: APPLY.REASON_MIN, prefill });
});

// POST /api/scholarships/:id/documents — upload one requested document before applying.
const uploadDocument = asyncHandler(async (req, res) => {
  const scholarship = await Scholarship.findById(req.params.id).select('requiredDocuments otherDocuments');
  if (!scholarship) throw new AppError('Scholarship not found.', 404);
  const doc = docListOf(scholarship).find((d) => d.key === req.body.key);
  if (!doc) throw new AppError('This document is not requested for this scholarship.', 422);
  const match = /^data:(image\/(png|jpe?g|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.file?.data || ''));
  if (!match) throw new AppError('Upload a PDF, PNG, JPG or WEBP file.', 422);
  const data = Buffer.from(match[3], 'base64');
  if (data.length > 3 * 1024 * 1024) throw new AppError('Each document must be 3 MB or smaller.', 422);
  const file = await require('../models/PrivateFile').create({ purpose: 'scholarship_document', owner: req.user._id, filename: String(req.body.file.name || doc.label).slice(0, 160), mimeType: match[1], size: data.length, data });
  return created(res, { fileId: file._id, key: doc.key, name: file.filename });
});

// GET /api/scholarships/applications/:appId/documents/:fileId — the donor (owner) or the applicant.
const applicationDocument = asyncHandler(async (req, res) => {
  const application = await ScholarshipApplication.findById(req.params.appId).populate('scholarship', 'donor');
  if (!application) throw new AppError('Document not found.', 404);
  const allowed = String(application.applicant) === String(req.user._id) || String(application.scholarship?.donor) === String(req.user._id);
  const doc = (application.documents || []).find((d) => String(d.file) === String(req.params.fileId));
  if (!allowed || !doc) throw new AppError('Document not found.', 404);
  return require('./resume.controller').sendPrivateFile(res, await require('../models/PrivateFile').findById(doc.file));
});

const myApplications = asyncHandler(async (req, res) => {
  const applications = await ScholarshipApplication.find({ applicant: req.user._id })
    .populate('scholarship', 'title amount currency status')
    .sort({ createdAt: -1 });
  return ok(res, applications);
});

// GET /api/scholarships/:id/applicants
const listApplicants = asyncHandler(async (req, res) => {
  const scholarship = await Scholarship.findById(req.params.id);
  if (!scholarship) throw new AppError('Scholarship not found.', 404);
  assertOwnsScholarship(scholarship, req.user._id);

  const applications = await ScholarshipApplication.find({ scholarship: scholarship._id })
    .populate('applicant', 'fullName email')
    .sort({ createdAt: -1 });
  return ok(res, applications);
});

// PATCH /api/scholarships/applications/:appId/status
const updateApplicationStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    throw new AppError('Invalid status.', 422);
  }

  let application;
  await mongoose.connection.transaction(async (session) => {
    application = await ScholarshipApplication.findById(req.params.appId).session(session);
    if (!application) throw new AppError('Application not found.', 404);
    const scholarship = await Scholarship.findById(application.scholarship).session(session);
    if (!scholarship) throw new AppError('Scholarship not found.', 404);
    assertOwnsScholarship(scholarship, req.user._id);

    // Every approval writes the scholarship document. Concurrent approvals therefore
    // conflict and retry against an up-to-date count instead of occupying one seat twice.
    await Scholarship.updateOne({ _id: scholarship._id }, { $inc: { seatRevision: 1 } }, { session });
    const existing = await Sponsorship.findOne({ application: application._id }).session(session);
    if (status === 'approved' && application.status !== 'approved') {
      const approved = await ScholarshipApplication.countDocuments({ scholarship: scholarship._id, status: 'approved' }).session(session);
      if (approved >= scholarship.seatsAvailable) throw new AppError('No scholarship seats remain.', 409);
      if (existing?.status === 'cancelled') {
        existing.status = 'active';
        await existing.save({ session });
      } else if (!existing) {
        await Sponsorship.create([{
          donor: req.user._id, scholarship: scholarship._id, application: application._id,
          student: application.applicant, amount: Math.round(scholarship.amount / scholarship.seatsAvailable),
          currency: scholarship.currency || 'USD'
        }], { session });
      }
    } else if (status !== 'approved' && existing && !['completed', 'cancelled'].includes(existing.status)) {
      existing.status = 'cancelled';
      await existing.save({ session });
    }
    application.status = status;
    application.reviewedAt = new Date();
    await application.save({ session });
    application.scholarship = scholarship;
  });

  const STATUS_LABEL = { pending: 'Under review', approved: 'Approved', rejected: 'Not selected' };
  await notify(application.applicant, {
    title: `${application.scholarship.title}: ${STATUS_LABEL[status]}`,
    body: status === 'approved' ? 'Congratulations. The donor will contact you about the next steps.' : status === 'rejected' ? 'Your application was not selected this time.' : 'Your application is under review.',
    sentBy: req.user._id, link: `/scholarships/${application.scholarship._id}`, category: 'scholarship'
  }, { email: true, emailPreference: 'applicationEmails', ctaLabel: 'View scholarship' }).catch(() => {});

  return ok(res, application, `Application ${status}.`);
});

// GET /api/scholarships/admin/all (admin oversight — every status, any donor)
const adminListAll = asyncHandler(async (req, res) => {
  const scholarships = await Scholarship.find({}).populate('donor', 'fullName email').sort({ createdAt: -1 });
  return ok(res, scholarships);
});

// GET /api/scholarships/mine/summary — Donor dashboard summary cards, all real aggregates.
const myScholarshipsSummary = asyncHandler(async (req, res) => {

  const scholarships = await Scholarship.find({ donor: req.user._id }).select('_id');
  const scholarshipIds = scholarships.map((s) => s._id);

  const [pendingRequests, sponsorships, deposits] = await Promise.all([
    ScholarshipApplication.countDocuments({ scholarship: { $in: scholarshipIds }, status: 'pending' }),
    Sponsorship.find({ donor: req.user._id }),
    DonorDeposit.find({ donor: req.user._id, status: 'confirmed' })
  ]);

  const nonCancelled = sponsorships.filter((s) => s.status !== 'cancelled');
  const totalsByCurrency = {};
  nonCancelled.forEach((s) => {
    const t = totalsByCurrency[s.currency] || { totalDonations: 0, active: 0, upcoming: 0, completed: 0, deposited: 0, walletBalance: 0 };
    t.totalDonations += s.amount;
    if (s.status === 'active') t.active += s.amount;
    if (s.status === 'pending') t.upcoming += s.amount;
    if (s.status === 'completed') t.completed += s.amount;
    totalsByCurrency[s.currency] = t;
  });
  deposits.forEach((d) => {
    const t = totalsByCurrency[d.currency] || { totalDonations: 0, active: 0, upcoming: 0, completed: 0, deposited: 0, walletBalance: 0 };
    t.deposited += d.amount;
    totalsByCurrency[d.currency] = t;
  });
  // Available balance = confirmed deposits minus whatever's already committed (pending + active).
  Object.values(totalsByCurrency).forEach((t) => { t.walletBalance = t.deposited - t.upcoming - t.active; });

  const activeSponsorshipsCount = sponsorships.filter((s) => s.status === 'active').length;
  const upcomingCommitmentsCount = sponsorships.filter((s) => s.status === 'pending').length;
  const completedDonationsCount = sponsorships.filter((s) => s.status === 'completed').length;
  const sponsoredStudentsNow = new Set(sponsorships.filter((s) => s.status === 'active').map((s) => s.student.toString())).size;
  const totalImpactAllTime = new Set(nonCancelled.map((s) => s.student.toString())).size;

  return ok(res, {
    activeSponsorships: activeSponsorshipsCount,
    sponsoredStudents: sponsoredStudentsNow,
    pendingRequests,
    totalImpact: totalImpactAllTime,
    upcomingCommitments: upcomingCommitmentsCount,
    completedDonations: completedDonationsCount,
    totalsByCurrency
  });
});

// GET /api/scholarships/mine/sponsorships — a donor's own sponsorship ledger. Includes the
// sponsored student's institution/program (from their StudentProfile), the originating
// application's real timestamps (for Impact Reports' milestone timeline), and paid/remaining breakdown.
const mySponsorships = asyncHandler(async (req, res) => {
  const sponsorships = await Sponsorship.find({ donor: req.user._id })
    .populate('scholarship', 'title')
    .populate('student', 'fullName email')
    .populate('application', 'createdAt reviewedAt')
    .sort({ createdAt: -1 });

  const studentIds = sponsorships.map((s) => s.student?._id).filter(Boolean);
  const profiles = await StudentProfile.find({ user: { $in: studentIds } })
    .populate('primaryInstitution', 'name')
    .select('user primaryInstitution program currentTerm');
  const profileByStudent = {};
  profiles.forEach((p) => { profileByStudent[p.user.toString()] = p; });

  const withDetails = sponsorships.map((s) => {
    const profile = profileByStudent[s.student?._id?.toString()];
    return {
      ...s.toObject(),
      institution: profile?.primaryInstitution || null,
      program: profile?.program || '',
      currentTerm: profile?.currentTerm || '',
      remainingAmount: Math.max(s.amount - s.paidAmount, 0)
    };
  });

  // Lazy reminder — no cron in this app, so this checks on the real page load: a scheduled
  // payment within the next 3 days gets a deduped "Sponsorship payment due" notification.
  const now = new Date();
  const in3Days = new Date(now.getTime() + 3 * 86400000);
  await Promise.all(withDetails.filter((s) => s.status === 'active' && s.nextPaymentDate && new Date(s.nextPaymentDate) > now && new Date(s.nextPaymentDate) <= in3Days).map(async (s) => {
    const title = `Sponsorship payment due: ${s.currency} ${s.remainingAmount} — ${s.scholarship?.title}`;
    const already = await Notification.findOne({ user: req.user._id, title });
    if (!already) await notify(req.user._id, { title, body: `Due ${new Date(s.nextPaymentDate).toLocaleDateString()}`, sentBy: null }).catch(() => {});
  }));

  return ok(res, withDetails);
});

// PATCH /api/scholarships/sponsorships/:id/status — donor moves their own sponsorship through
// pending -> active (funds disbursed) -> paused/completed, or cancels it.
const updateSponsorshipStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'active', 'paused', 'completed', 'cancelled'].includes(status)) throw new AppError('Invalid status.', 422);

  const sponsorship = await Sponsorship.findById(req.params.id).populate('scholarship', 'title');
  if (!sponsorship) throw new AppError('Sponsorship not found.', 404);
  if (sponsorship.donor.toString() !== req.user._id.toString()) throw new AppError('You did not create this sponsorship.', 403);

  sponsorship.status = status;
  await sponsorship.save();

  await notify(sponsorship.student, {
    title: `Sponsorship update: ${sponsorship.scholarship?.title} — ${status}`,
    sentBy: req.user._id
  }).catch(() => {});

  if (status === 'completed') {
    await notify(req.user._id, {
      title: `Impact report available: ${sponsorship.scholarship?.title}`,
      sentBy: req.user._id
    }).catch(() => {});
  }

  return ok(res, sponsorship, 'Sponsorship updated.');
});

// PATCH /api/scholarships/sponsorships/:id/payment — donor logs a real payment made toward
// their commitment (no payment processor in this app, so this is a donor-confirmed record) and
// optionally sets the next payment date.
const recordSponsorshipPayment = asyncHandler(async (req, res) => {
  throw new AppError('This payment method was replaced. Use Pay by bank transfer (CareerZ checks the receipts).', 410);
  // eslint-disable-next-line no-unreachable
  const { amount, paymentMethod, reference, proofUrl, provider, nextPaymentDate } = req.body;

  const sponsorship = await Sponsorship.findById(req.params.id).populate('scholarship', 'title');
  if (!sponsorship) throw new AppError('Sponsorship not found.', 404);
  if (sponsorship.donor.toString() !== req.user._id.toString()) throw new AppError('You did not create this sponsorship.', 403);

  const paymentAmount = Number(amount);
  if (!(paymentAmount > 0) || paymentAmount > sponsorship.amount - sponsorship.paidAmount) throw new AppError('Enter a valid amount up to the remaining sponsorship balance.', 422);
  if (!['bank_transfer', 'mobile_wallet', 'cash', 'other'].includes(paymentMethod)) throw new AppError('Choose a valid manual payment method.', 422);
  if (!String(reference || '').trim()) throw new AppError('Payment reference is required.', 422);
  if (paymentMethod !== 'cash' && !String(proofUrl || '').trim()) throw new AppError('Payment proof is required.', 422);
  if (sponsorship.paymentHistory.some((p) => p.status === 'pending')) throw new AppError('A sponsorship payment is already awaiting student verification.', 409);
  sponsorship.paymentHistory.push({ amount: paymentAmount, paymentMethod, reference: String(reference).trim(), proofUrl: String(proofUrl || '').trim(), provider: String(provider || '').trim() });
  if (nextPaymentDate !== undefined) sponsorship.nextPaymentDate = nextPaymentDate || null;
  await sponsorship.save();

  await notify(sponsorship.student, {
    title: `Sponsorship payment awaiting your verification — ${sponsorship.scholarship?.title}: ${sponsorship.currency} ${paymentAmount}`,
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, sponsorship, 'Payment submitted for student verification.');
});

const receivedSponsorshipPayments = asyncHandler(async (req, res) => {
  const rows = await Sponsorship.find({ student: req.user._id, 'paymentHistory.status': 'pending' }).populate('donor', 'fullName email').populate('scholarship', 'title');
  return ok(res, rows);
});

const verifySponsorshipPayment = asyncHandler(async (req, res) => {
  throw new AppError('This payment method was replaced. Use Pay by bank transfer (CareerZ checks the receipts).', 410);
  // eslint-disable-next-line no-unreachable
  const sponsorship = await Sponsorship.findOne({ _id: req.params.id, student: req.user._id });
  if (!sponsorship) throw new AppError('Sponsorship not found.', 404);
  const payment = sponsorship.paymentHistory.id(req.params.paymentId);
  if (!payment || payment.status !== 'pending') throw new AppError('Pending sponsorship payment not found.', 404);
  const { decision, rejectionReason } = req.body;
  if (decision === 'reject') {
    if (!String(rejectionReason || '').trim()) throw new AppError('A rejection reason is required.', 422);
    payment.status = 'rejected'; payment.rejectedAt = new Date(); payment.rejectionReason = String(rejectionReason).trim();
  } else if (decision === 'verify') {
    payment.status = 'verified'; payment.verifiedAt = new Date(); sponsorship.paidAmount = Math.min(sponsorship.amount, sponsorship.paidAmount + payment.amount);
    if (sponsorship.paidAmount >= sponsorship.amount) sponsorship.status = 'completed'; else if (sponsorship.status === 'pending') sponsorship.status = 'active';
  } else throw new AppError('decision must be verify or reject.', 422);
  await sponsorship.save();
  return ok(res, sponsorship, decision === 'verify' ? 'Sponsorship payment verified.' : 'Sponsorship payment rejected.');
});

// POST /api/scholarships/donor/deposit — request to fund the wallet. No real payment
// processor in this app — this creates a real, trackable request, not fake money.
const requestDeposit = asyncHandler(async (req, res) => {
  // Wallet money now comes in through Add Funds → Pay by bank transfer (CareerZ account).
  throw new AppError('This payment method was replaced. Use Pay by bank transfer (CareerZ checks the receipts).', 410);
  // eslint-disable-next-line no-unreachable
  const { amount, currency, paymentMethod, reference, proofUrl, provider } = req.body;
  if (!amount || amount <= 0) throw new AppError('amount must be a positive number.', 422);
  if (!paymentMethod || !PAYMENT_METHOD_LABEL[paymentMethod]) {
    throw new AppError('A valid paymentMethod is required (bank_transfer, card, mobile_wallet, cash or other).', 422);
  }
  if (paymentMethod === 'card') throw new AppError('Card deposits require a verified gateway checkout.', 422);
  if (!String(reference || '').trim()) throw new AppError('Payment reference or cash receipt number is required.', 422);
  if (paymentMethod !== 'cash' && !String(proofUrl || '').trim()) throw new AppError('Payment proof is required.', 422);

  const deposit = await DonorDeposit.create({ donor: req.user._id, amount, currency: currency || 'USD', paymentMethod, paymentReference: String(reference).trim(), paymentProofUrl: String(proofUrl || '').trim(), paymentProvider: String(provider || '').trim() });
  return created(res, deposit, 'Deposit requested.');
});

// GET /api/scholarships/mine/deposits — a donor's own deposit history.
const myDeposits = asyncHandler(async (req, res) => {
  const deposits = await DonorDeposit.find({ donor: req.user._id }).sort({ createdAt: -1 });
  return ok(res, deposits);
});

const adminListDeposits = asyncHandler(async (req, res) => {
  const deposits = await DonorDeposit.find({ status: 'requested' }).populate('donor', 'fullName email').sort({ createdAt: 1 });
  return ok(res, deposits);
});

// PATCH /api/scholarships/deposits/:id/status — admin confirms/rejects a deposit request.
const updateDepositStatus = asyncHandler(async (req, res) => {
  const { status, rejectionReason } = req.body;
  if (!['requested', 'confirmed', 'rejected'].includes(status)) throw new AppError('Invalid status.', 422);

  const deposit = await DonorDeposit.findById(req.params.id);
  if (!deposit) throw new AppError('Deposit not found.', 404);
  deposit.status = status;
  deposit.reviewedBy = req.user._id; deposit.reviewedAt = new Date();
  if (status === 'rejected') {
    if (!String(rejectionReason || '').trim()) throw new AppError('A rejection reason is required.', 422);
    deposit.rejectionReason = String(rejectionReason).trim();
  }
  if (status === 'confirmed') deposit.transactionId = generateTransactionId();
  await deposit.save();

  await notify(deposit.donor, {
    title: status === 'confirmed'
      ? `Deposit confirmed: ${deposit.currency} ${deposit.amount} (receipt ${deposit.transactionId})`
      : `Deposit ${status}: ${deposit.currency} ${deposit.amount}`,
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, deposit, 'Deposit updated.');
});

module.exports = { applyForm, uploadDocument, applicationDocument,
  createScholarship,
  adminListAll,
  listScholarships,
  getScholarship,
  myScholarships,
  updateScholarship,
  applyToScholarship,
  myApplications,
  listApplicants,
  updateApplicationStatus,
  myScholarshipsSummary,
  mySponsorships,
  updateSponsorshipStatus,
  recordSponsorshipPayment,
  requestDeposit, adminListDeposits, receivedSponsorshipPayments, verifySponsorshipPayment,
  myDeposits,
  updateDepositStatus
};
