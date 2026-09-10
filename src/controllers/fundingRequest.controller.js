const FundingRequest = require('../models/FundingRequest');
const Donation = require('../models/Donation');
const User = require('../models/User');
const Setting = require('../models/Setting');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { notify, notifyMany } = require('../services/notification.service');

const DONATIONS_ENABLED_KEY = 'donations_enabled';

// GET /api/funding-requests/settings/donations-enabled — any authenticated user can read it
// (the donor UI needs to know whether to show "Donate Now" at all).
const getDonationsEnabled = asyncHandler(async (req, res) => {
  const setting = await Setting.findOne({ key: DONATIONS_ENABLED_KEY });
  return ok(res, { enabled: setting ? setting.value !== false : true });
});

// PATCH /api/funding-requests/settings/donations-enabled — Super Admin platform-wide kill switch.
const setDonationsEnabled = asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') throw new AppError('enabled must be a boolean.', 422);
  await Setting.findOneAndUpdate({ key: DONATIONS_ENABLED_KEY }, { key: DONATIONS_ENABLED_KEY, value: enabled }, { upsert: true });
  return ok(res, { enabled }, `Donations feature ${enabled ? 'enabled' : 'disabled'} platform-wide.`);
});

// Every donor who has put real money toward this request before — used so they hear about
// verification changes and "fully funded" without needing a stored per-donor subscription.
async function notifyPastDonors(requestId, payload, excludeUserId) {
  const donorIds = await Donation.find({ fundingRequest: requestId }).distinct('donor');
  const ids = donorIds.map((id) => id.toString()).filter((id) => id !== (excludeUserId && excludeUserId.toString()));
  if (ids.length > 0) await notifyMany(ids, payload).catch(() => {});
}

// POST /api/funding-requests — a student or institution owner asks for funding.
const createFundingRequest = asyncHandler(async (req, res) => {
  const allowed = ['requestType', 'category', 'educationLevel', 'title', 'purpose', 'requiredAmount', 'currency', 'country', 'institution', 'applicationDeadline', 'documents'];
  const body = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) body[f] = req.body[f]; });
  if (!body.requestType || !body.category || !body.title || body.requiredAmount === undefined) {
    throw new AppError('requestType, category, title and requiredAmount are required.', 422);
  }

  const request = await FundingRequest.create({ ...body, requestedBy: req.user._id });

  const donorIds = await User.find({ roles: 'donor' }).select('_id');
  await notifyMany(donorIds.map((u) => u._id), {
    title: `New matching funding request: ${request.title}`,
    sentBy: req.user._id
  }).catch(() => {});

  return created(res, request, 'Funding request submitted — pending verification.');
});

// GET /api/funding-requests — public/donor browse (open requests only), with the full
// Donation Opportunities filter set: country, institution, education level, category,
// required-amount range, and verified-only.
const listFundingRequests = asyncHandler(async (req, res) => {
  const { country, requestType, category, institution, educationLevel, minAmount, maxAmount, verifiedOnly } = req.query;
  const filter = { status: 'open' };
  if (country) filter.country = country;
  if (requestType) filter.requestType = requestType;
  if (category) filter.category = category;
  if (institution) filter.institution = institution;
  if (educationLevel) filter.educationLevel = educationLevel;
  if (verifiedOnly === 'true') filter.verificationStatus = 'verified';
  if (minAmount || maxAmount) {
    filter.requiredAmount = {};
    if (minAmount) filter.requiredAmount.$gte = Number(minAmount);
    if (maxAmount) filter.requiredAmount.$lte = Number(maxAmount);
  }
  const requests = await FundingRequest.find(filter).populate('requestedBy', 'fullName').populate('institution', 'name').sort({ createdAt: -1 }).limit(100);
  return ok(res, requests);
});

// GET /api/funding-requests/applications — Donor item 9: every request a donor can review,
// any status (unlike the open-only browse above), so New/Under Review/Approved/Partially Funded/
// Funded/Rejected are all visible with the requester's institution and documents.
const listApplications = asyncHandler(async (req, res) => {
  const requests = await FundingRequest.find({})
    .populate('requestedBy', 'fullName email')
    .populate('institution', 'name country type')
    .sort({ createdAt: -1 })
    .limit(200);
  return ok(res, requests);
});

// GET /api/funding-requests/recommended — real, computed ranking (not an AI call): prioritizes
// verified requests, the least-funded (most need), and the soonest deadlines.
const listRecommended = asyncHandler(async (req, res) => {
  const requests = await FundingRequest.find({ status: 'open' })
    .populate('requestedBy', 'fullName')
    .populate('institution', 'name')
    .sort({ createdAt: -1 })
    .limit(100);

  const now = new Date();
  const scored = requests.map((r) => {
    const remaining = Math.max(r.requiredAmount - r.collectedAmount, 0);
    const percentFunded = r.requiredAmount > 0 ? (r.collectedAmount / r.requiredAmount) * 100 : 0;
    const daysToDeadline = r.applicationDeadline ? Math.max((new Date(r.applicationDeadline) - now) / 86400000, 0) : 999;
    // Lower score = more urgent/recommended: verified requests, low funding %, closer deadlines.
    const score = (r.verificationStatus === 'verified' ? 0 : 50) + percentFunded * 0.5 + Math.min(daysToDeadline, 60);
    return { ...r.toObject(), remainingAmount: remaining, percentFunded: Math.round(percentFunded), score };
  }).sort((a, b) => a.score - b.score).slice(0, 30);

  return ok(res, scored);
});

// GET /api/funding-requests/:id
const getFundingRequest = asyncHandler(async (req, res) => {
  const request = await FundingRequest.findById(req.params.id).populate('requestedBy', 'fullName email').populate('institution', 'name');
  if (!request) throw new AppError('Funding request not found.', 404);
  return ok(res, request);
});

// GET /api/funding-requests/mine — the requester's own submissions.
const myFundingRequests = asyncHandler(async (req, res) => {
  const requests = await FundingRequest.find({ requestedBy: req.user._id }).sort({ createdAt: -1 });
  return ok(res, requests);
});

// POST /api/funding-requests/:id/donate — "Donate Now" (type=donation) or "Sponsor Student"
// (type=sponsorship). Both create a real Donation record and bump collectedAmount for real.
const donate = asyncHandler(async (req, res) => {
  const donationsEnabled = await Setting.findOne({ key: DONATIONS_ENABLED_KEY });
  if (donationsEnabled && donationsEnabled.value === false) {
    throw new AppError('Donations are temporarily disabled platform-wide by the Super Admin.', 403);
  }

  const request = await FundingRequest.findById(req.params.id).populate('requestedBy', 'fullName');
  if (!request) throw new AppError('Funding request not found.', 404);
  if (request.status !== 'open') throw new AppError('This request is no longer open for donations.', 400);
  if (request.applicationStatus === 'rejected') throw new AppError('This request was rejected and cannot receive donations.', 400);
  if (request.verificationStatus !== 'verified') {
    throw new AppError('Only Super Admin-verified requests can receive donations.', 403);
  }

  const { amount, type, paymentMethod } = req.body;
  if (!amount || amount <= 0) throw new AppError('amount must be a positive number.', 422);
  if (type && !['donation', 'sponsorship'].includes(type)) throw new AppError('Invalid donation type.', 422);
  if (paymentMethod && !['bank_transfer', 'card', 'mobile_wallet', 'cash', 'other'].includes(paymentMethod)) {
    throw new AppError('Invalid paymentMethod.', 422);
  }

  const donation = await Donation.create({
    donor: req.user._id,
    fundingRequest: request._id,
    amount,
    currency: request.currency,
    type: type || 'donation',
    paymentMethod: paymentMethod || 'other',
    transactionId: `TXN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  });

  request.collectedAmount += amount;
  const justFulfilled = request.collectedAmount >= request.requiredAmount && request.status !== 'fulfilled';
  if (request.collectedAmount >= request.requiredAmount) {
    request.status = 'fulfilled';
    request.applicationStatus = 'funded';
  } else {
    request.applicationStatus = 'partially_funded';
  }
  await request.save();

  await notify(request.requestedBy._id, {
    title: `${type === 'sponsorship' ? 'New sponsor' : 'New donation'}: ${request.currency} ${amount} — ${request.title}`,
    sentBy: req.user._id
  }).catch(() => {});

  await notify(req.user._id, {
    title: `Donation successful: ${request.currency} ${amount} — ${request.title}`,
    sentBy: req.user._id
  }).catch(() => {});

  if (justFulfilled) {
    await notifyPastDonors(request._id, { title: `Request fully funded: ${request.title}`, sentBy: req.user._id });
  }

  return created(res, donation, 'Donation recorded.');
});

// POST /api/funding-requests/:id/save
const saveRequest = asyncHandler(async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $addToSet: { savedFundingRequests: req.params.id } });
  return ok(res, null, 'Request saved.');
});

// DELETE /api/funding-requests/:id/save
const unsaveRequest = asyncHandler(async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $pull: { savedFundingRequests: req.params.id } });
  return ok(res, null, 'Request removed from saved list.');
});

// GET /api/funding-requests/mine/saved
const listSaved = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).populate({ path: 'savedFundingRequests', populate: { path: 'requestedBy institution', select: 'fullName name' } });
  return ok(res, (user.savedFundingRequests || []).filter(Boolean));
});

// GET /api/funding-requests/mine/donations — a donor's own donation history: recipient,
// purpose, amount, currency, payment method, transaction id, status.
const myDonations = asyncHandler(async (req, res) => {
  const donations = await Donation.find({ donor: req.user._id })
    .populate({ path: 'fundingRequest', select: 'title requestType category purpose requestedBy institution', populate: [{ path: 'requestedBy', select: 'fullName' }, { path: 'institution', select: 'name' }] })
    .sort({ createdAt: -1 });
  return ok(res, donations);
});

// PATCH /api/funding-requests/donations/:id/status — the donor self-reports what really
// happened with a payment (there is no live payment gateway to confirm this automatically).
// Reconciles the funding request's collectedAmount/status either direction.
const updateDonationStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'successful', 'failed', 'refunded'].includes(status)) throw new AppError('Invalid status.', 422);

  const donation = await Donation.findById(req.params.id);
  if (!donation) throw new AppError('Donation not found.', 404);
  if (donation.donor.toString() !== req.user._id.toString()) throw new AppError('You did not make this donation.', 403);

  const wasCounted = donation.status === 'successful';
  const willBeCounted = status === 'successful';

  if (wasCounted !== willBeCounted) {
    const request = await FundingRequest.findById(donation.fundingRequest);
    if (request) {
      request.collectedAmount = Math.max(request.collectedAmount + (willBeCounted ? donation.amount : -donation.amount), 0);
      const justFulfilled = request.collectedAmount >= request.requiredAmount && request.requiredAmount > 0 && request.status !== 'fulfilled';
      if (request.collectedAmount >= request.requiredAmount && request.requiredAmount > 0) {
        request.status = 'fulfilled';
        request.applicationStatus = 'funded';
      } else {
        if (request.status === 'fulfilled') request.status = 'open';
        if (request.applicationStatus !== 'rejected') {
          request.applicationStatus = request.collectedAmount > 0 ? 'partially_funded' : 'approved';
        }
      }
      await request.save();
      if (justFulfilled) {
        await notifyPastDonors(request._id, { title: `Request fully funded: ${request.title}`, sentBy: req.user._id });
      }
    }
  }

  donation.status = status;
  await donation.save();

  if (status === 'failed') {
    await notify(donation.donor, { title: `Donation failed: ${donation.currency} ${donation.amount}`, sentBy: req.user._id }).catch(() => {});
  }

  return ok(res, donation, 'Donation status updated.');
});

// PATCH /api/funding-requests/:id/application-status — a donor reviewing the request moves it
// through New -> Under Review -> Approved/Rejected. Partially Funded/Funded are normally set
// automatically by donate(), but a donor can still correct them by hand if needed.
const updateApplicationStatus = asyncHandler(async (req, res) => {
  const { applicationStatus } = req.body;
  if (!['new', 'under_review', 'approved', 'partially_funded', 'funded', 'rejected'].includes(applicationStatus)) {
    throw new AppError('Invalid applicationStatus.', 422);
  }

  const request = await FundingRequest.findById(req.params.id);
  if (!request) throw new AppError('Funding request not found.', 404);

  request.applicationStatus = applicationStatus;
  await request.save();

  await notify(request.requestedBy, {
    title: `Your funding request is now: ${applicationStatus.replace('_', ' ')} — ${request.title}`,
    sentBy: req.user._id
  }).catch(() => {});

  return ok(res, request, 'Application status updated.');
});

// PATCH /api/funding-requests/:id/verify — admin reviews and verifies/rejects a request.
const verifyRequest = asyncHandler(async (req, res) => {
  const { verificationStatus } = req.body;
  if (!['pending', 'verified', 'rejected'].includes(verificationStatus)) throw new AppError('Invalid verificationStatus.', 422);

  const request = await FundingRequest.findById(req.params.id);
  if (!request) throw new AppError('Funding request not found.', 404);
  request.verificationStatus = verificationStatus;
  await request.save();

  await notify(request.requestedBy, {
    title: `Funding request ${verificationStatus}: ${request.title}`,
    sentBy: req.user._id
  }).catch(() => {});

  await notifyPastDonors(request._id, { title: `Verification update: ${request.title} is now ${verificationStatus}`, sentBy: req.user._id }, req.user._id);

  return ok(res, request, 'Verification updated.');
});

module.exports = {
  createFundingRequest, listFundingRequests, listApplications, listRecommended, getFundingRequest, myFundingRequests,
  donate, saveRequest, unsaveRequest, listSaved, myDonations, updateDonationStatus, updateApplicationStatus, verifyRequest,
  getDonationsEnabled, setDonationsEnabled
};
