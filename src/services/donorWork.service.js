const mongoose = require('mongoose');
const User = require('../models/User');
const Setting = require('../models/Setting');
const AppError = require('../utils/AppError');

// Master donor rules: verification asks the source of funds for large donations (6.10); the
// donor's AI picks the best applications, writes impact reports and forecasts future giving;
// Super Admin lists donors (name, organisation, country, status), sees their activity, verifies
// and suspends them (Donor Management).

const fail = (m, c = 422) => new AppError(m, c);
const oid = (v) => mongoose.isValidObjectId(v);
const LARGE_KEY = 'large_donation_threshold_pkr';

// ---------------------------------------------------------------- large donations
// A Super Admin setting; unset (0) means no source-of-funds question.
async function largeDonationThreshold() {
  const s = await Setting.findOne({ key: LARGE_KEY }).lean();
  const n = Number(s?.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
async function setLargeDonationThreshold(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw fail('Enter an amount in PKR (0 turns the question off).');
  await Setting.findOneAndUpdate({ key: LARGE_KEY }, { key: LARGE_KEY, value: n }, { upsert: true });
  return { thresholdPkr: n };
}

// ---------------------------------------------------------------- Super Admin
async function listDonors({ q = '' } = {}) {
  const filter = { roles: 'donor' };
  if (q) filter.$or = [{ fullName: new RegExp(String(q).slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { email: String(q).toLowerCase().trim() }];
  const donors = await User.find(filter).select('fullName email phone status country createdAt').sort({ createdAt: -1 }).limit(300).lean();
  const ids = donors.map((d) => d._id);
  const [profiles, requests, scholarships, sponsorships, donations] = await Promise.all([
    require('../models/UserProfile').find({ user: { $in: ids }, role: 'donor' }).select('user fields subtype').lean(),
    require('../models/RoleRequest').find({ user: { $in: ids }, requestedRole: 'donor' }).select('user status').lean(),
    require('../models/Scholarship').aggregate([{ $match: { donor: { $in: ids } } }, { $group: { _id: '$donor', n: { $sum: 1 } } }]),
    require('../models/Sponsorship').aggregate([{ $match: { donor: { $in: ids } } }, { $group: { _id: '$donor', n: { $sum: 1 }, paid: { $sum: '$paidAmount' } } }]),
    require('../models/Donation').aggregate([{ $match: { donor: { $in: ids }, status: 'successful' } }, { $group: { _id: '$donor', n: { $sum: 1 }, total: { $sum: '$amount' } } }])
  ]);
  const by = (rows) => Object.fromEntries(rows.map((r) => [String(r._id || r.user), r]));
  const prof = Object.fromEntries(profiles.map((p) => [String(p.user), p]));
  const verif = Object.fromEntries(requests.map((r) => [String(r.user), r.status]));
  const sch = by(scholarships); const spo = by(sponsorships); const don = by(donations);
  return donors.map((d) => {
    const k = String(d._id);
    const f = prof[k]?.fields || {};
    return {
      ...d, kind: prof[k]?.subtype || '', organization: f.organizationName || '', country: f.country || d.country || '', verification: verif[k] || 'not_requested',
      scholarships: sch[k]?.n || 0, sponsorships: spo[k]?.n || 0, sponsoredPaid: spo[k]?.paid || 0, donations: don[k]?.n || 0, donated: don[k]?.total || 0
    };
  });
}

async function activity(donorId) {
  if (!oid(donorId)) throw fail('Donor not found.', 404);
  const donor = await User.findById(donorId).select('fullName email phone status roles createdAt').lean();
  if (!donor) throw fail('Donor not found.', 404);
  const ManualPayment = require('../models/ManualPayment');
  const [profile, scholarships, sponsorships, donations, payments, complaints] = await Promise.all([
    require('../models/UserProfile').findOne({ user: donorId, role: 'donor' }).select('fields subtype').lean(),
    require('../models/Scholarship').find({ donor: donorId }).select('title status amount currency seatsAvailable createdAt').sort({ createdAt: -1 }).limit(100).lean(),
    require('../models/Sponsorship').find({ donor: donorId }).populate('student', 'fullName').populate('scholarship', 'title').select('amount paidAmount currency status createdAt student scholarship').sort({ createdAt: -1 }).limit(100).lean(),
    require('../models/Donation').find({ donor: donorId }).populate('fundingRequest', 'title requestType').select('amount currency status createdAt fundingRequest').sort({ createdAt: -1 }).limit(100).lean(),
    ManualPayment.find({ payer: donorId }).select('number kind title currency price commission status sourceOfFunds createdAt').sort({ createdAt: -1 }).limit(100).lean(),
    require('../models/Complaint').find({ targetId: donorId }).select('subject category status createdAt').limit(50).lean()
  ]);
  const { fields = {}, subtype = '' } = profile || {};
  const safe = Object.fromEntries(Object.entries(fields).filter(([k]) => !/cnic|passport|national/i.test(k)));
  return { donor, kind: subtype, profile: safe, scholarships, sponsorships, donations, payments, complaints };
}

// ---------------------------------------------------------------- donor AI (the donor's own key)
async function rankApplications(user, scholarshipId) {
  if (!oid(scholarshipId)) throw fail('Scholarship not found.', 404);
  const scholarship = await require('../models/Scholarship').findOne({ _id: scholarshipId, donor: user._id }).lean();
  if (!scholarship) throw fail('Scholarship not found.', 404);
  const apps = await require('../models/ScholarshipApplication').find({ scholarship: scholarshipId, status: 'pending' }).populate('applicant', 'fullName').limit(40).lean();
  if (!apps.length) return { ranking: [] };
  const profiles = await require('../models/UserProfile').find({ user: { $in: apps.map((a) => a.applicant?._id) }, role: 'student' }).select('user fields').lean();
  const pf = Object.fromEntries(profiles.map((p) => [String(p.user), p.fields || {}]));
  const brief = apps.map((a, i) => {
    // The application form when present, else the student profile.
    const f = { ...(pf[String(a.applicant?._id)] || {}), ...(a.form || {}) };
    return `#${i + 1} | program: ${f.currentDegree || f.educationLevel || ''} at ${f.currentInstitution || f.institutionName || ''} | last result: ${f.lastResult || ''} | family income PKR: ${f.monthlyFamilyIncome || ''} for ${f.dependents || '?'} people | city: ${f.city || ''} | reason: ${String(a.statement || '').slice(0, 600)}`;
  }).join('\n').slice(0, 12000);
  const text = await require('./ai.service').generate(user._id,
    'You help a scholarship donor shortlist fairly. Rank applicants on fit with the eligibility criteria, financial need and merit shown in the given text only. Never use names, gender, religion or ethnicity. Reply ONLY as JSON: [{"n":<number>,"score":<0-100>,"reason":"<one sentence>"}].',
    `Scholarship: ${scholarship.title}\nEligibility: ${String(scholarship.eligibilityCriteria || '').slice(0, 1500)}\nDescription: ${String(scholarship.description || '').slice(0, 1500)}\n\nApplicants:\n${brief}`);
  let list = [];
  try { list = JSON.parse(String(text).slice(String(text).indexOf('['), String(text).lastIndexOf(']') + 1)); } catch { throw fail('The AI answer could not be read. Try again.', 502); }
  return { ranking: list.filter((x) => apps[Number(x.n) - 1]).map((x) => ({ applicationId: apps[Number(x.n) - 1]._id, name: apps[Number(x.n) - 1].applicant?.fullName || 'Applicant', score: Math.max(0, Math.min(100, Number(x.score) || 0)), reason: String(x.reason || '').slice(0, 300) })).sort((a, b) => b.score - a.score) };
}

// Giving so far by month (all currencies in PKR at the platform rates).
async function givingHistory(donorId) {
  // Calendar months in UTC, so a month never shifts with the server timezone.
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const ManualPayment = require('../models/ManualPayment');
  const sponsorshipPayments = await ManualPayment.find({ payer: donorId, status: 'approved', kind: 'sponsorship_payment', createdAt: { $gte: since } }).select('price currency createdAt').lean();
  const donations = await require('../models/Donation').find({ donor: donorId, status: 'successful', createdAt: { $gte: since } }).select('amount currency createdAt').lean();
  const rates = Object.fromEntries((await require('../models/Currency').find({}).select('code exchangeRateToUSD').lean()).map((c) => [c.code, c.exchangeRateToUSD]));
  const pkr = (amount, cur) => (cur === 'PKR' || !rates[cur] || !rates.PKR ? amount : (amount * rates[cur]) / rates.PKR);
  const months = {};
  for (let i = 0; i < 12; i++) months[new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth() + i, 1)).toISOString().slice(0, 7)] = 0;
  const add = (date, amount, cur) => { const k = new Date(date).toISOString().slice(0, 7); if (k in months) months[k] += pkr(amount, cur); };
  for (const r of sponsorshipPayments) add(r.createdAt, r.price, r.currency);
  for (const d of donations) add(d.createdAt, d.amount, d.currency);
  return Object.entries(months).map(([month, amount]) => ({ month, amountPkr: Math.round(amount) }));
}

// Next three months from the last six (simple trend), with an AI reading when asked.
async function forecast(user, { ai = false } = {}) {
  const history = await givingHistory(user._id);
  const last6 = history.slice(-6).map((m) => m.amountPkr);
  const avg = last6.reduce((s, v) => s + v, 0) / 6;
  const slope = last6.length > 1 ? (last6[5] - last6[0]) / 5 : 0;
  const next = [1, 2, 3].map((k) => Math.max(0, Math.round(avg + slope * (2.5 + k))));
  const out = { history, forecastPkr: next, method: 'Average of the last 6 months plus their trend.' };
  if (!ai) return out;
  const text = await require('./ai.service').generate(user._id, 'You advise a donor in Pakistan about their giving plan. Use ONLY the numbers given. 4 short bullet points starting with "- ".', JSON.stringify(out));
  return { ...out, insight: String(text || '').trim() };
}

// Impact report: who the donor reached, from the records; AI writes it up when asked.
async function impactReport(user, { ai = false } = {}) {
  const [sponsorships, donations, scholarships] = await Promise.all([
    require('../models/Sponsorship').find({ donor: user._id }).populate('scholarship', 'title').select('amount paidAmount currency status student scholarship').lean(),
    require('../models/Donation').find({ donor: user._id, status: 'successful' }).populate('fundingRequest', 'title requestType category').select('amount currency fundingRequest').lean(),
    require('../models/Scholarship').find({ donor: user._id }).select('title seatsAvailable').lean()
  ]);
  const byType = {};
  for (const d of donations) { const t = d.fundingRequest?.requestType || 'other'; byType[t] = (byType[t] || 0) + d.amount; }
  const facts = {
    scholarshipsPosted: scholarships.length,
    studentsSponsored: new Set(sponsorships.map((s) => String(s.student))).size,
    sponsorshipCommitted: sponsorships.reduce((s, x) => s + (x.amount || 0), 0),
    sponsorshipPaid: sponsorships.reduce((s, x) => s + (x.paidAmount || 0), 0),
    completedSponsorships: sponsorships.filter((s) => s.status === 'completed').length,
    donationsCount: donations.length,
    donatedByRecipientType: byType,
    causes: [...new Set(donations.map((d) => d.fundingRequest?.category).filter(Boolean))]
  };
  if (!ai) return { facts };
  const text = await require('./ai.service').generate(user._id, 'Write a short, warm impact report for a donor, in plain sentences, using ONLY these facts. No invented stories or numbers.', JSON.stringify(facts));
  return { facts, report: String(text || '').trim() };
}

module.exports = { LARGE_KEY, largeDonationThreshold, setLargeDonationThreshold, listDonors, activity, rankApplications, forecast, impactReport };
