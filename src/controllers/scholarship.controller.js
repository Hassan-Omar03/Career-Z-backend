const Scholarship = require('../models/Scholarship');
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

function assertOwnsScholarship(scholarship, userId) {
  if (scholarship.donor.toString() !== userId.toString()) {
    throw new AppError('You did not create this scholarship.', 403);
  }
}

// POST /api/scholarships
const createScholarship = asyncHandler(async (req, res) => {
  if (!(await isRoleVerified(req.user._id, 'donor'))) {
    throw new AppError('Your Donor account is pending Super Admin verification. You can browse the dashboard but cannot post a scholarship until it is approved.', 403);
  }

  const allowed = [
    'title', 'description', 'amount', 'currency', 'eligibilityCriteria',
    'country', 'applicationDeadline', 'seatsAvailable'
  ];
  const body = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) body[f] = req.body[f]; });
  if (!body.title || body.amount === undefined) {
    throw new AppError('title and amount are required.', 422);
  }

  const scholarship = await Scholarship.create({ ...body, donor: req.user._id });
  return created(res, scholarship, 'Scholarship posted.');
});

// GET /api/scholarships (public browse)
const listScholarships = asyncHandler(async (req, res) => {
  const { country } = req.query;
  const filter = { status: 'open' };
  if (country) filter.country = country;
  const scholarships = await Scholarship.find(filter).populate('donor', 'fullName email').sort({ createdAt: -1 }).limit(100);
  return ok(res, scholarships);
});

// GET /api/scholarships/:id
const getScholarship = asyncHandler(async (req, res) => {
  const scholarship = await Scholarship.findById(req.params.id).populate('donor', 'fullName email');
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

  const allowed = [
    'title', 'description', 'amount', 'currency', 'eligibilityCriteria',
    'country', 'applicationDeadline', 'seatsAvailable', 'status'
  ];
  allowed.forEach((f) => { if (req.body[f] !== undefined) scholarship[f] = req.body[f]; });
  await scholarship.save();
  return ok(res, scholarship);
});

// POST /api/scholarships/:id/apply
const applyToScholarship = asyncHandler(async (req, res) => {
  const scholarship = await Scholarship.findById(req.params.id);
  if (!scholarship) throw new AppError('Scholarship not found.', 404);
  if (scholarship.status !== 'open') throw new AppError('This scholarship is closed.', 400);

  const existing = await ScholarshipApplication.findOne({ scholarship: scholarship._id, applicant: req.user._id });
  if (existing) throw new AppError('You already applied to this scholarship.', 409);

  const application = await ScholarshipApplication.create({
    scholarship: scholarship._id,
    applicant: req.user._id,
    statement: req.body.statement || ''
  });

  return created(res, application, 'Application submitted.');
});

// GET /api/scholarships/mine/applications (as applicant)
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

  const application = await ScholarshipApplication.findById(req.params.appId).populate('scholarship');
  if (!application) throw new AppError('Application not found.', 404);
  assertOwnsScholarship(application.scholarship, req.user._id);

  application.status = status;
  application.reviewedAt = new Date();
  await application.save();

  const STATUS_LABEL = { pending: 'Under review', approved: 'Approved', rejected: 'Not selected' };
  await notify(application.applicant, {
    title: `${application.scholarship.title}: ${STATUS_LABEL[status]}`,
    sentBy: req.user._id
  }).catch(() => {});

  // A real, individual funding commitment — the scholarship's pool split across its seats.
  if (status === 'approved') {
    const existing = await Sponsorship.findOne({ application: application._id });
    if (!existing) {
      const seats = application.scholarship.seatsAvailable || 1;
      const amount = Math.round(application.scholarship.amount / seats);
      await Sponsorship.create({
        donor: req.user._id,
        scholarship: application.scholarship._id,
        application: application._id,
        student: application.applicant,
        amount,
        currency: application.scholarship.currency || 'USD'
      });
    }
  } else {
    // The commitment fell through — cancel the sponsorship it would have created.
    await Sponsorship.updateOne(
      { application: application._id, status: { $nin: ['completed', 'cancelled'] } },
      { status: 'cancelled' }
    );
  }

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
  const { paidAmount, nextPaymentDate } = req.body;

  const sponsorship = await Sponsorship.findById(req.params.id).populate('scholarship', 'title');
  if (!sponsorship) throw new AppError('Sponsorship not found.', 404);
  if (sponsorship.donor.toString() !== req.user._id.toString()) throw new AppError('You did not create this sponsorship.', 403);

  if (paidAmount !== undefined) {
    if (paidAmount < 0) throw new AppError('paidAmount cannot be negative.', 422);
    sponsorship.paidAmount = Math.min(paidAmount, sponsorship.amount);
  }
  if (nextPaymentDate !== undefined) sponsorship.nextPaymentDate = nextPaymentDate || null;
  await sponsorship.save();

  await notify(sponsorship.student, {
    title: `Payment recorded — ${sponsorship.scholarship?.title}: ${sponsorship.currency} ${sponsorship.paidAmount} paid so far`,
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, sponsorship, 'Payment recorded.');
});

// POST /api/scholarships/donor/deposit — request to fund the wallet. No real payment
// processor in this app — this creates a real, trackable request, not fake money.
const requestDeposit = asyncHandler(async (req, res) => {
  const { amount, currency } = req.body;
  if (!amount || amount <= 0) throw new AppError('amount must be a positive number.', 422);

  const deposit = await DonorDeposit.create({ donor: req.user._id, amount, currency: currency || 'USD' });
  return created(res, deposit, 'Deposit requested.');
});

// GET /api/scholarships/mine/deposits — a donor's own deposit history.
const myDeposits = asyncHandler(async (req, res) => {
  const deposits = await DonorDeposit.find({ donor: req.user._id }).sort({ createdAt: -1 });
  return ok(res, deposits);
});

// PATCH /api/scholarships/deposits/:id/status — admin confirms/rejects a deposit request.
const updateDepositStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['requested', 'confirmed', 'rejected'].includes(status)) throw new AppError('Invalid status.', 422);

  const deposit = await DonorDeposit.findById(req.params.id);
  if (!deposit) throw new AppError('Deposit not found.', 404);
  deposit.status = status;
  await deposit.save();

  await notify(deposit.donor, {
    title: `Deposit ${status}: ${deposit.currency} ${deposit.amount}`,
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, deposit, 'Deposit updated.');
});

module.exports = {
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
  requestDeposit,
  myDeposits,
  updateDepositStatus
};
