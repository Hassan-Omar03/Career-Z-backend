const mongoose = require('mongoose');
const FreelanceProfile = require('../models/FreelanceProfile');
const FreelanceService = require('../models/FreelanceService');
const FreelanceProposal = require('../models/FreelanceProposal');
const FreelanceOrder = require('../models/FreelanceOrder');
const FreelanceDispute = require('../models/FreelanceDispute');
const Job = require('../models/Job');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const AppError = require('../utils/AppError');
const { notify, notifyAdmins } = require('./notification.service');

// Master Phase A4 sections 6, 8 and 12, and the client's specification 6.1:
//   a service is listed or a freelance job is posted → the freelancer proposes milestones →
//   the client accepts and pays CareerZ, which holds the money → the freelancer delivers →
//   the client approves → the amount goes to the freelancer's wallet.
// CareerZ's commission is added on top when the client pays, so the milestone amount is what the
// freelancer receives. A dispute freezes the money until a CareerZ admin decides.

const fail = (m, s = 422) => new AppError(m, s);
const oid = (v) => mongoose.isValidObjectId(v);
const same = (a, b) => String(a?._id || a) === String(b?._id || b);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const AUTO_RELEASE_DAYS = 7;
const ORDER_LINK = (o) => `/dashboard?tab=freelance&order=${o._id}`;
const PEOPLE = 'fullName profilePhoto city country';
const httpsOnly = (u) => /^https:\/\/\S+$/.test(String(u || ''));
const files = (list, label) => [].concat(list || []).slice(0, 10).map((f) => {
  if (!httpsOnly(f?.url)) throw fail(`${label} must be uploaded files.`);
  return { name: String(f.name || 'File').trim().slice(0, 120), url: String(f.url).slice(0, 600) };
});

// ------------------------------------------------------------------ reputation (master A4 section 12)
async function reputation(userId) {
  const orders = await FreelanceOrder.find({ seller: userId }).select('status review createdAt firstResponseAt milestones').lean();
  const reviews = orders.filter((o) => o.review?.rating);
  const done = orders.filter((o) => o.status === 'completed').length;
  const lost = orders.filter((o) => o.status === 'cancelled' && o.milestones.some((m) => m.fundedAt)).length;
  const complaints = await FreelanceDispute.countDocuments({ order: { $in: orders.map((o) => o._id) } });
  const responded = orders.filter((o) => o.firstResponseAt);
  const responseHours = responded.length ? round2(responded.reduce((s, o) => s + (new Date(o.firstResponseAt) - new Date(o.createdAt)), 0) / responded.length / 36e5) : null;
  const rating = reviews.length ? round2(reviews.reduce((s, o) => s + o.review.rating, 0) / reviews.length) : null;
  const completionRate = done + lost ? Math.round((done / (done + lost)) * 100) : null;
  const trustScore = rating === null && completionRate === null ? null
    : Math.max(0, Math.round((rating ?? 4) * 10 + (completionRate ?? 80) * 0.5 - Math.min(30, complaints * 10)));
  return { rating, reviewCount: reviews.length, completedOrders: done, completionRate, responseHours, complaints, trustScore: trustScore === null ? null : Math.min(100, trustScore) };
}

// ------------------------------------------------------------------ profile
const myProfile = async (user) => (await FreelanceProfile.findOne({ user: user._id }).lean()) || { user: user._id, type: 'Freelancer', headline: '', about: '', skills: [], portfolio: [], isNew: true };
async function saveProfile(user, body = {}) {
  if (body.type !== undefined && !FreelanceProfile.TYPES.includes(body.type)) throw fail('Choose what you offer from the list.');
  const portfolio = [].concat(body.portfolio || []).slice(0, 20).map((p) => {
    if (p.url && !httpsOnly(p.url)) throw fail('A portfolio link must start with https://');
    if (p.image && !httpsOnly(p.image)) throw fail('A portfolio image must be an uploaded picture.');
    return { title: String(p.title || '').trim().slice(0, 120), url: p.url || '', image: p.image || '' };
  });
  const skills = [].concat(body.skills || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 30);
  const set = { ...(body.type ? { type: body.type } : {}), headline: String(body.headline || '').trim().slice(0, 120), about: String(body.about || '').trim().slice(0, 3000), skills, portfolio };
  return FreelanceProfile.findOneAndUpdate({ user: user._id }, { $set: set, $setOnInsert: { user: user._id } }, { upsert: true, new: true, runValidators: true });
}

// ------------------------------------------------------------------ services
function cleanService(body = {}, existing = null) {
  const title = String(body.title ?? existing?.title ?? '').trim().slice(0, 120);
  if (title.length < 5) throw fail('Give the service a clear title.');
  const category = body.category ?? existing?.category ?? 'other';
  if (!FreelanceService.CATEGORIES.includes(category)) throw fail('Choose a valid category.');
  const description = String(body.description ?? existing?.description ?? '').trim().slice(0, 6000);
  const image = String(body.image ?? existing?.image ?? '').trim();
  if (image && !httpsOnly(image)) throw fail('The service image must be an uploaded picture.');
  const raw = body.packages ?? existing?.packages ?? [];
  const packages = [].concat(raw).filter((p) => p && p.price !== '' && p.price != null).map((p) => {
    if (!['basic', 'standard', 'premium'].includes(p.tier)) throw fail('Packages are Basic, Standard and Premium.');
    const price = Number(p.price), deliveryDays = Number(p.deliveryDays), revisions = Number(p.revisions || 0);
    if (!(price > 0)) throw fail('Each package needs a price above zero.');
    if (!Number.isInteger(deliveryDays) || deliveryDays < 1 || deliveryDays > 365) throw fail('Delivery time is 1 to 365 days.');
    if (!Number.isInteger(revisions) || revisions < 0 || revisions > 50) throw fail('Revisions are a whole number up to 50.');
    return { tier: p.tier, name: String(p.name || '').trim().slice(0, 60), price, deliveryDays, revisions, includes: String(p.includes || '').trim().slice(0, 600) };
  });
  if (!packages.length) throw fail('Add at least one package with a price.');
  if (new Set(packages.map((p) => p.tier)).size !== packages.length) throw fail('Use each package level once.');
  return { title, category, description, image, packages, startingAt: Math.min(...packages.map((p) => p.price)), currency: String(body.currency || existing?.currency || 'PKR').toUpperCase().slice(0, 6) };
}
// No per-post approval: only what the automatic check finds suspicious waits for an admin.
async function scan(service) {
  const { flags, held } = await require('./autoModeration.service').checkFreelanceService(service);
  service.moderation = { flags, at: new Date() };
  return held;
}
async function createService(user, body) {
  const service = new FreelanceService({ ...cleanService(body), seller: user._id });
  if (await scan(service)) service.status = 'pending_review';
  await service.save();
  if (service.status === 'pending_review') await notifyAdmins({ title: `Freelance service to check: ${service.title}`, body: service.moderation.flags.map((f) => f.label).join(', '), link: '/dashboard?ws=admin&tab=freelanceAdmin' }).catch(() => {});
  return service;
}
async function ownService(user, id) {
  const service = oid(id) ? await FreelanceService.findById(id) : null;
  if (!service || !same(service.seller, user)) throw fail('Service not found.', 404);
  return service;
}
async function updateService(user, id, body) {
  const service = await ownService(user, id);
  if (service.status === 'removed') throw fail(`CareerZ removed this service: ${service.adminRemoval?.reason || ''}`, 409);
  Object.assign(service, cleanService(body, service));
  const held = await scan(service);
  if (held) service.status = 'pending_review'; else if (service.status === 'pending_review') service.status = 'active';
  return service.save();
}
async function setServiceStatus(user, id, status) {
  const service = await ownService(user, id);
  if (!['active', 'paused'].includes(status)) throw fail('Choose active or paused.');
  if (['removed', 'pending_review'].includes(service.status)) throw fail('CareerZ has to clear this service first.', 409);
  service.status = status;
  return service.save();
}
const myServices = (user) => FreelanceService.find({ seller: user._id }).sort({ createdAt: -1 }).lean();

const card = (s, rep) => ({ _id: s._id, title: s.title, category: s.category, image: s.image, currency: s.currency, startingAt: Math.min(...s.packages.map((p) => p.price)), fastest: Math.min(...s.packages.map((p) => p.deliveryDays)), seller: s.seller ? { _id: s.seller._id, name: s.seller.fullName, photo: s.seller.profilePhoto, city: s.seller.city } : null, rating: rep?.rating ?? null, reviewCount: rep?.reviewCount ?? 0 });
const liveSellers = (rows) => User.find({ _id: { $in: rows.map((s) => s.seller?._id || s.seller) }, status: 'active' }).distinct('_id').then((ids) => new Set(ids.map(String)));
async function publicServices(query = {}) {
  const filter = { status: 'active' };
  const min = Number(query.minPrice), max = Number(query.maxPrice);
  if (min > 0 || max > 0) filter.startingAt = { ...(min > 0 ? { $gte: min } : {}), ...(max > 0 ? { $lte: max } : {}) };
  const SORTS = { newest: { createdAt: -1 }, price_low: { startingAt: 1, createdAt: -1 }, price_high: { startingAt: -1, createdAt: -1 } };
  if (FreelanceService.CATEGORIES.includes(query.category)) filter.category = query.category;
  const q = String(query.q || '').trim().slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (q) filter.$or = [{ title: new RegExp(q, 'i') }, { description: new RegExp(q, 'i') }];
  const page = Math.max(1, Math.floor(Number(query.page)) || 1), limit = 24;
  // Only services whose seller's account is active.
  filter.seller = { $in: await User.find({ status: 'active', _id: { $in: await FreelanceService.distinct('seller', filter) } }).distinct('_id') };
  const [rows, total] = await Promise.all([FreelanceService.find(filter).populate('seller', PEOPLE).sort(SORTS[query.sort] || SORTS.newest).skip((page - 1) * limit).limit(limit).lean(), FreelanceService.countDocuments(filter)]);
  const live = rows.filter((s) => s.seller);
  const reps = new Map(await Promise.all([...new Set(live.map((s) => String(s.seller._id)))].map(async (u) => [u, await reputation(u)])));
  return { items: live.map((s) => card(s, reps.get(String(s.seller._id)))), total, page, pages: Math.ceil(total / limit), categories: FreelanceService.CATEGORIES };
}
async function publicService(id) {
  const s = oid(id) ? await FreelanceService.findOne({ _id: id, status: 'active' }).populate('seller', PEOPLE).lean() : null;
  if (!s || !s.seller || !(await liveSellers([s])).has(String(s.seller._id))) throw fail('This service is not available.', 404);
  const [rep, profile, reviews] = await Promise.all([
    reputation(s.seller._id),
    FreelanceProfile.findOne({ user: s.seller._id }).lean(),
    FreelanceOrder.find({ seller: s.seller._id, 'review.rating': { $exists: true } }).populate('buyer', 'fullName').sort({ 'review.at': -1 }).limit(10).select('review buyer').lean()
  ]);
  return { ...s, seller: { _id: s.seller._id, name: s.seller.fullName, photo: s.seller.profilePhoto, city: s.seller.city }, reputation: rep, profile: profile ? { type: profile.type, headline: profile.headline, about: profile.about, skills: profile.skills, portfolio: profile.portfolio } : null, reviews: reviews.map((r) => ({ rating: r.review.rating, text: r.review.text, at: r.review.at, by: r.buyer?.fullName || 'Client' })) };
}

async function publicFreelancer(id) {
  const user = oid(id) ? await User.findOne({ _id: id, status: 'active' }).select(PEOPLE).lean() : null;
  if (!user) throw fail('This freelancer is not available.', 404);
  const [rep, profile, services, reviews] = await Promise.all([
    reputation(user._id),
    FreelanceProfile.findOne({ user: user._id }).lean(),
    FreelanceService.find({ seller: user._id, status: 'active' }).sort({ createdAt: -1 }).limit(50).lean(),
    FreelanceOrder.find({ seller: user._id, 'review.rating': { $exists: true } }).populate('buyer', 'fullName').sort({ 'review.at': -1 }).limit(20).select('review buyer').lean()
  ]);
  if (!profile && !services.length) throw fail('This freelancer is not available.', 404);
  return {
    _id: user._id, name: user.fullName, photo: user.profilePhoto, city: user.city, reputation: rep,
    profile: profile ? { type: profile.type, headline: profile.headline, about: profile.about, skills: profile.skills, portfolio: profile.portfolio } : null,
    services: services.map((s) => card({ ...s, seller: { _id: user._id, fullName: user.fullName, profilePhoto: user.profilePhoto, city: user.city } }, rep)),
    reviews: reviews.map((r) => ({ rating: r.review.rating, text: r.review.text, at: r.review.at, by: r.buyer?.fullName || 'Client' }))
  };
}

// ------------------------------------------------------------------ orders from a package
async function orderService(user, id, { tier } = {}) {
  const s = oid(id) ? await FreelanceService.findOne({ _id: id, status: 'active' }) : null;
  if (!s) throw fail('This service is not available.', 404);
  if (same(s.seller, user)) throw fail('You cannot order your own service.', 403);
  if (!(await liveSellers([s])).has(String(s.seller))) throw fail('This service is not available.', 404);
  const pack = s.packages.find((p) => p.tier === tier);
  if (!pack) throw fail('Choose a package.');
  const order = await FreelanceOrder.create({
    buyer: user._id, seller: s.seller, service: s._id, title: s.title, packageTier: tier, category: s.category, currency: s.currency, revisionsAllowed: pack.revisions,
    milestones: [{ title: pack.name || `${tier[0].toUpperCase()}${tier.slice(1)} package`, amount: pack.price, deliveryDays: pack.deliveryDays }]
  });
  await notify(s.seller, { title: `New order: ${s.title}`, body: `${user.fullName} chose your ${tier} package. Work starts when CareerZ confirms the payment.`, link: ORDER_LINK(order), category: 'freelance' }).catch(() => {});
  return order;
}

// ------------------------------------------------------------------ proposals on freelance jobs
function cleanMilestones(list, fee) {
  const rows = [].concat(list || []).map((m) => {
    const amount = Number(m.amount), title = String(m.title || '').trim().slice(0, 120);
    if (!title || !(amount > 0)) throw fail('Each milestone needs a title and an amount.');
    const dueDate = m.dueDate ? new Date(m.dueDate) : null;
    if (dueDate && Number.isNaN(dueDate.getTime())) throw fail('A milestone date is not valid.');
    return { title, amount: round2(amount), dueDate };
  });
  if (!rows.length) throw fail('Add at least one milestone.');
  if (rows.length > 20) throw fail('Use up to 20 milestones.');
  if (round2(rows.reduce((s, m) => s + m.amount, 0)) !== round2(fee)) throw fail('The milestones must add up to your fee.');
  return rows;
}
async function propose(user, jobId, body = {}) {
  const job = oid(jobId) ? await Job.findOne({ _id: jobId, type: 'freelance', status: 'active' }) : null;
  if (!job) throw fail('This freelance job is not open.', 404);
  if (same(job.postedBy, user)) throw fail('You cannot send a proposal on your own job.', 403);
  const fee = round2(body.fee);
  if (!(fee > 0)) throw fail('Enter your fee.');
  const coverLetter = String(body.coverLetter || '').trim();
  if (coverLetter.length < 20) throw fail('Write a little more about how you would do this work.');
  try {
    const proposal = await FreelanceProposal.create({ job: job._id, client: job.postedBy, freelancer: user._id, coverLetter: coverLetter.slice(0, 3000), fee, currency: job.currency || 'PKR', milestones: cleanMilestones(body.milestones, fee), attachments: files(body.attachments, 'Attachments') });
    await notify(job.postedBy, { title: `New proposal: ${job.title}`, body: `${user.fullName} offered ${proposal.currency} ${fee}.`, link: '/dashboard?tab=freelance&freelanceHub=proposals', category: 'freelance' }).catch(() => {});
    return proposal;
  } catch (e) { if (e?.code === 11000) throw fail('You already sent a proposal on this job.', 409); throw e; }
}
const myProposals = (user) => FreelanceProposal.find({ freelancer: user._id }).populate('job', 'title company').sort({ createdAt: -1 }).lean();
async function receivedProposals(user) {
  const rows = await FreelanceProposal.find({ client: user._id }).populate('job', 'title').populate('freelancer', PEOPLE).sort({ createdAt: -1 }).lean();
  const reps = new Map(await Promise.all([...new Set(rows.map((p) => String(p.freelancer?._id)))].filter((x) => x !== 'undefined').map(async (u) => [u, await reputation(u)])));
  return rows.map((p) => ({ ...p, reputation: reps.get(String(p.freelancer?._id)) || null }));
}
async function decideProposal(user, id, decision) {
  if (!['accept', 'decline'].includes(decision)) throw fail('Choose accept or decline.');
  const p = oid(id) ? await FreelanceProposal.findById(id).populate('job', 'title category') : null;
  if (!p || !same(p.client, user)) throw fail('Proposal not found.', 404);
  const claimed = await FreelanceProposal.findOneAndUpdate({ _id: p._id, status: 'submitted' }, { $set: { status: decision === 'accept' ? 'accepted' : 'declined' } }, { new: true });
  if (!claimed) throw fail('This proposal was already decided.', 409);
  if (decision === 'decline') { await notify(p.freelancer, { title: `Proposal declined: ${p.job?.title || 'job'}`, category: 'freelance' }).catch(() => {}); return { proposal: claimed }; }
  const order = await FreelanceOrder.create({ buyer: p.client, seller: p.freelancer, job: p.job?._id, proposal: p._id, title: p.job?.title || 'Freelance work', category: p.job?.category || '', currency: p.currency, milestones: p.milestones.map((m) => ({ title: m.title, amount: m.amount, dueDate: m.dueDate })) });
  claimed.order = order._id; await claimed.save();
  await notify(p.freelancer, { title: `Proposal accepted: ${order.title}`, body: 'Work starts when CareerZ confirms the first payment.', link: ORDER_LINK(order), category: 'freelance' }).catch(() => {});
  return { proposal: claimed, order };
}
async function withdrawProposal(user, id) {
  const p = oid(id) ? await FreelanceProposal.findOneAndUpdate({ _id: id, freelancer: user._id, status: 'submitted' }, { $set: { status: 'withdrawn' } }, { new: true }) : null;
  if (!p) throw fail('This proposal cannot be withdrawn.', 409);
  return p;
}

// ------------------------------------------------------------------ order workspace
async function memberOrder(user, id) {
  const o = oid(id) ? await FreelanceOrder.findById(id) : null;
  if (!o || !(same(o.buyer, user) || same(o.seller, user))) throw fail('Order not found.', 404);
  return o;
}
const milestoneOf = (o, mId) => { const m = o.milestones.id(mId); if (!m) throw fail('Milestone not found.', 404); return m; };
const decorate = (o, user) => ({ ...o, escrowBalance: round2(o.milestones.filter((m) => ['funded', 'submitted', 'revision', 'disputed'].includes(m.status)).reduce((s, m) => s + m.amount, 0)), role: same(o.buyer, user) ? 'client' : 'freelancer' });
async function myOrders(user) {
  await autoRelease({ $or: [{ buyer: user._id }, { seller: user._id }] });
  const rows = await FreelanceOrder.find({ $or: [{ buyer: user._id }, { seller: user._id }] }).populate('buyer', PEOPLE).populate('seller', PEOPLE).sort({ updatedAt: -1 }).limit(200).lean();
  return rows.map((o) => decorate(o, user));
}
async function getOrder(user, id) {
  await memberOrder(user, id);
  await autoRelease({ _id: id });
  const o = await FreelanceOrder.findById(id).populate('buyer', PEOPLE).populate('seller', PEOPLE).populate('messages.from', 'fullName').lean();
  const disputes = await FreelanceDispute.find({ order: id }).populate('initiator', 'fullName').sort({ createdAt: -1 }).lean();
  return { ...decorate(o, user), disputes };
}
function respond(o, user) { if (!o.firstResponseAt && same(o.seller, user)) o.firstResponseAt = new Date(); }
async function postMessage(user, id, text) {
  const o = await memberOrder(user, id);
  const clean = String(text || '').trim().slice(0, 2000);
  if (!clean) throw fail('Write a message.');
  o.messages.push({ from: user._id, text: clean });
  respond(o, user);
  await o.save();
  await notify(same(o.buyer, user) ? o.seller : o.buyer, { title: `Message on ${o.title}`, body: clean.slice(0, 140), link: ORDER_LINK(o), category: 'freelance' }).catch(() => {});
  return getOrder(user, id);
}
async function cancelOrder(user, id) {
  const o = await memberOrder(user, id);
  if (o.status !== 'active' || o.milestones.some((m) => m.status !== 'pending')) throw fail('An order can be cancelled only before any payment.', 409);
  const open = await require('../models/ManualPayment').exists({ freelanceOrder: o._id, status: { $in: ['submitted', 'commission_submitted', 'commission_verified'] } });
  if (open) throw fail('A payment for this order is being checked by CareerZ.', 409);
  o.status = 'cancelled';
  await o.save();
  await notify(same(o.buyer, user) ? o.seller : o.buyer, { title: `Order cancelled: ${o.title}`, link: ORDER_LINK(o), category: 'freelance' }).catch(() => {});
  return o;
}

// The client pays CareerZ for one milestone, through the same bank-transfer check as every payment.
async function payableMilestone(user, milestoneId) {
  const o = oid(milestoneId) ? await FreelanceOrder.findOne({ 'milestones._id': milestoneId }) : null;
  if (!o || !same(o.buyer, user)) throw fail('Milestone not found.', 404);
  if (o.status !== 'active') throw fail('This order is not active.', 409);
  const m = milestoneOf(o, milestoneId);
  if (m.status !== 'pending') throw fail('This milestone is already paid.', 409);
  return { order: o, milestone: m };
}
// Inside the payment approval.
async function hold(mp, session) {
  const o = await FreelanceOrder.findById(mp.freelanceOrder).session(session);
  if (!o) throw fail('Order not found.', 404);
  const m = milestoneOf(o, mp.freelanceMilestone);
  if (m.status !== 'pending') throw fail('This milestone is already paid.', 409);
  m.status = 'funded';
  m.fundedAt = new Date();
  m.feePaid = round2(mp.price - m.amount);
  if (!m.dueDate && m.deliveryDays) m.dueDate = new Date(Date.now() + m.deliveryDays * 864e5);
  await o.save({ session });
}
async function tellFunded(mp) {
  const o = await FreelanceOrder.findById(mp.freelanceOrder);
  if (!o) return;
  const m = o.milestones.id(mp.freelanceMilestone);
  await notify(o.seller, { title: `Start work: ${o.title}`, body: `CareerZ holds ${o.currency} ${m?.amount} for "${m?.title}". You receive it when the client approves your work.`, link: ORDER_LINK(o), category: 'freelance' }, { email: true }).catch(() => {});
  await notify(o.buyer, { title: `Payment confirmed: ${o.title}`, body: 'CareerZ holds it until you approve the work.', link: ORDER_LINK(o), category: 'freelance' }).catch(() => {});
}

async function submitWork(user, id, mId, body = {}) {
  const o = await memberOrder(user, id);
  if (!same(o.seller, user)) throw fail('Only the freelancer delivers the work.', 403);
  const m = milestoneOf(o, mId);
  if (!['funded', 'revision'].includes(m.status)) throw fail(m.status === 'pending' ? 'Wait until CareerZ confirms the payment for this milestone.' : 'This milestone cannot take a delivery now.', 409);
  const note = String(body.note || '').trim().slice(0, 3000);
  const list = files(body.files, 'Deliverables');
  if (!note && !list.length) throw fail('Add a note or a file with your delivery.');
  Object.assign(m, { status: 'submitted', note, files: list, submittedAt: new Date(), revisionNote: '' });
  respond(o, user);
  await o.save();
  await notify(o.buyer, { title: `Work delivered: ${m.title}`, body: `Check it and approve, or ask for changes. It is paid automatically after ${AUTO_RELEASE_DAYS} days with no reply.`, link: ORDER_LINK(o), category: 'freelance' }, { email: true }).catch(() => {});
  return getOrder(user, id);
}

// Moves the milestone once, even on a double click: the wallet is credited in the same transaction.
async function payFreelancer(orderId, milestoneId, from, by) {
  let paid = null;
  await mongoose.connection.transaction(async (session) => {
    const o = await FreelanceOrder.findById(orderId).session(session);
    const m = o?.milestones.id(milestoneId);
    if (!m || !from.includes(m.status)) throw fail('This milestone was already decided.', 409);
    m.status = 'approved'; m.approvedAt = new Date(); m.approvedBy = by;
    if (o.milestones.every((x) => ['approved', 'refunded'].includes(x.status))) o.status = 'completed';
    else if (o.status === 'disputed' && !o.milestones.some((x) => x.status === 'disputed')) o.status = 'active';
    await o.save({ session });
    await Wallet.findOneAndUpdate({ user: o.seller, currency: o.currency }, { $inc: { available: m.amount } }, { upsert: true, session, setDefaultsOnInsert: true });
    await WalletTransaction.create([{ user: o.seller, type: 'transfer_in', amount: m.amount, currency: o.currency, status: 'completed', reference: `FL-${m._id}-IN`, counterparty: o.buyer, note: `Freelance: ${o.title} (${m.title})` }], { session });
    paid = { order: o, milestone: m };
  });
  await notify(paid.order.seller, { title: `Payment released: ${paid.order.currency} ${paid.milestone.amount}`, body: `"${paid.milestone.title}" is now in your wallet.`, link: ORDER_LINK(paid.order), category: 'freelance' }, { email: true }).catch(() => {});
  return paid;
}
async function approveWork(user, id, mId) {
  const o = await memberOrder(user, id);
  if (!same(o.buyer, user)) throw fail('Only the client approves the work.', 403);
  milestoneOf(o, mId);
  await payFreelancer(o._id, mId, ['submitted'], 'client');
  return getOrder(user, id);
}
// No reply in time: the freelancer is paid. Runs whenever orders are opened (no scheduler needed).
async function autoRelease(filter = {}) {
  const before = new Date(Date.now() - AUTO_RELEASE_DAYS * 864e5);
  const orders = await FreelanceOrder.find({ ...filter, milestones: { $elemMatch: { status: 'submitted', submittedAt: { $lte: before } } } }).select('milestones');
  for (const o of orders) for (const m of o.milestones) if (m.status === 'submitted' && m.submittedAt <= before) await payFreelancer(o._id, m._id, ['submitted'], 'auto').catch(() => {});
}
async function askRevision(user, id, mId, note) {
  const o = await memberOrder(user, id);
  if (!same(o.buyer, user)) throw fail('Only the client asks for changes.', 403);
  const m = milestoneOf(o, mId);
  if (m.status !== 'submitted') throw fail('There is no delivery to change.', 409);
  const text = String(note || '').trim().slice(0, 1000);
  if (text.length < 5) throw fail('Write what needs to change.');
  if (o.service && m.revisionsUsed >= o.revisionsAllowed) throw fail('This package has no revisions left. Approve the work or open a dispute.', 409);
  Object.assign(m, { status: 'revision', revisionNote: text, revisionsUsed: m.revisionsUsed + 1 });
  await o.save();
  await notify(o.seller, { title: `Changes requested: ${m.title}`, body: text.slice(0, 140), link: ORDER_LINK(o), category: 'freelance' }).catch(() => {});
  return getOrder(user, id);
}
async function openDispute(user, id, mId, body = {}) {
  const o = await memberOrder(user, id);
  const m = milestoneOf(o, mId);
  if (!['funded', 'submitted', 'revision'].includes(m.status)) throw fail('CareerZ is not holding money for this milestone.', 409);
  const reason = String(body.reason || '').trim();
  if (reason.length < 10) throw fail('Explain the problem so CareerZ can decide.');
  const dispute = await FreelanceDispute.create({ order: o._id, milestone: m._id, initiator: user._id, reason: reason.slice(0, 2000), evidence: files(body.evidence, 'Evidence'), previousStatus: m.status });
  m.status = 'disputed'; o.status = 'disputed';
  await o.save();
  await notify(same(o.buyer, user) ? o.seller : o.buyer, { title: `Dispute opened: ${o.title}`, body: 'CareerZ holds the money and will decide.', link: ORDER_LINK(o), category: 'freelance' }, { email: true }).catch(() => {});
  await notifyAdmins({ title: `Freelance dispute: ${o.title}`, body: reason.slice(0, 140), link: '/dashboard?ws=admin&tab=freelanceAdmin' }).catch(() => {});
  return dispute;
}
async function leaveReview(user, id, body = {}) {
  const o = await memberOrder(user, id);
  if (!same(o.buyer, user)) throw fail('Only the client reviews the work.', 403);
  if (!o.milestones.some((m) => m.status === 'approved')) throw fail('You can review after approving the work.', 409);
  if (o.review?.rating) throw fail('You already reviewed this order.', 409);
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw fail('Choose 1 to 5 stars.');
  o.review = { rating, text: String(body.text || '').trim().slice(0, 1000), at: new Date() };
  await o.save();
  return getOrder(user, id);
}
async function earnings(user) {
  const orders = await FreelanceOrder.find({ seller: user._id }).select('currency milestones status').lean();
  const by = {};
  for (const o of orders) {
    const row = by[o.currency] || (by[o.currency] = { currency: o.currency, released: 0, held: 0, waiting: 0 });
    for (const m of o.milestones) {
      if (m.status === 'approved') row.released = round2(row.released + m.amount);
      else if (['funded', 'submitted', 'revision', 'disputed'].includes(m.status)) row.held = round2(row.held + m.amount);
      else if (m.status === 'pending' && o.status === 'active') row.waiting = round2(row.waiting + m.amount);
    }
  }
  const history = await WalletTransaction.find({ user: user._id, reference: /^FL-.*-IN$/ }).sort({ createdAt: -1 }).limit(30).select('amount currency note createdAt').lean();
  return { totals: Object.values(by), history, reputation: await reputation(user._id) };
}

// ------------------------------------------------------------------ admin
async function adminOverview() {
  const [disputes, held, orders] = await Promise.all([
    FreelanceDispute.find().populate('initiator', 'fullName').populate({ path: 'order', select: 'title currency milestones buyer seller messages', populate: [{ path: 'buyer', select: 'fullName' }, { path: 'seller', select: 'fullName' }, { path: 'messages.from', select: 'fullName' }] }).sort({ status: 1, createdAt: -1 }).limit(100).lean(),
    FreelanceService.find({ status: { $in: ['pending_review', 'active', 'paused', 'removed'] } }).populate('seller', 'fullName').sort({ status: 1, createdAt: -1 }).limit(200).lean(),
    FreelanceOrder.find().populate('buyer', 'fullName').populate('seller', 'fullName').sort({ updatedAt: -1 }).limit(100).select('title currency status milestones buyer seller').lean()
  ]);
  const totals = {};
  for (const row of await FreelanceOrder.aggregate([{ $unwind: '$milestones' }, { $group: { _id: { currency: '$currency', status: '$milestones.status' }, amount: { $sum: '$milestones.amount' }, fees: { $sum: '$milestones.feePaid' } } }])) {
    const t = totals[row._id.currency] || (totals[row._id.currency] = { currency: row._id.currency, held: 0, released: 0, refunded: 0, fees: 0 });
    if (['funded', 'submitted', 'revision', 'disputed'].includes(row._id.status)) t.held = round2(t.held + row.amount);
    if (row._id.status === 'approved') t.released = round2(t.released + row.amount);
    if (row._id.status === 'refunded') t.refunded = round2(t.refunded + row.amount);
    t.fees = round2(t.fees + row.fees);
  }
  return { totals: Object.values(totals), disputes: disputes.map((d) => ({ ...d, milestoneRow: d.order?.milestones?.find((m) => String(m._id) === String(d.milestone)) || null })), services: held, orders };
}
async function adminService(admin, id, { action, reason } = {}) {
  await require('../utils/platformFinance').assertPlatformFinance(admin).catch(() => { if (!admin.roles?.some((r) => ['admin', 'super_admin'].includes(r))) throw fail('Admins only.', 403); });
  const s = oid(id) ? await FreelanceService.findById(id) : null;
  if (!s) throw fail('Service not found.', 404);
  if (action === 'approve') s.status = 'active';
  else if (action === 'remove') {
    const text = String(reason || '').trim().slice(0, 500);
    if (text.length < 3) throw fail('Write why it is removed; the owner sees it.');
    s.status = 'removed'; s.adminRemoval = { by: admin._id, at: new Date(), reason: text };
    await notify(s.seller, { title: `CareerZ removed your service: ${s.title}`, body: text, category: 'freelance' }, { email: true }).catch(() => {});
  } else throw fail('Choose approve or remove.');
  return s.save();
}
// A CareerZ admin decides: pay the freelancer, or refund the milestone amount to the client's wallet.
async function resolveDispute(admin, id, { decision, note } = {}) {
  await require('../utils/platformFinance').assertPlatformFinance(admin);
  if (!['release', 'refund'].includes(decision)) throw fail('Choose release or refund.');
  const text = String(note || '').trim().slice(0, 1000);
  if (text.length < 3) throw fail('Write the reason for your decision; both sides see it.');
  const claimed = oid(id) ? await FreelanceDispute.findOneAndUpdate({ _id: id, status: 'open' }, { $set: { status: decision === 'release' ? 'resolved' : 'refunded', resolution: { by: admin._id, at: new Date(), note: text } } }, { new: true }) : null;
  if (!claimed) throw fail('This dispute was already decided.', 409);
  let order;
  if (decision === 'release') {
    order = (await payFreelancer(claimed.order, claimed.milestone, ['disputed'], 'admin')).order;
  } else {
    await mongoose.connection.transaction(async (session) => {
      const o = await FreelanceOrder.findById(claimed.order).session(session);
      const m = o.milestones.id(claimed.milestone);
      if (m.status !== 'disputed') throw fail('This milestone was already decided.', 409);
      m.status = 'refunded';
      if (o.milestones.every((x) => ['approved', 'refunded'].includes(x.status))) o.status = o.milestones.some((x) => x.status === 'approved') ? 'completed' : 'cancelled';
      else if (!o.milestones.some((x) => x.status === 'disputed')) o.status = 'active';
      await o.save({ session });
      await Wallet.findOneAndUpdate({ user: o.buyer, currency: o.currency }, { $inc: { available: m.amount } }, { upsert: true, session, setDefaultsOnInsert: true });
      await WalletTransaction.create([{ user: o.buyer, type: 'transfer_in', amount: m.amount, currency: o.currency, status: 'completed', reference: `FL-${m._id}-REFUND`, counterparty: o.seller, note: `Freelance refund: ${o.title} (${m.title})` }], { session });
      order = o;
    });
  }
  for (const who of [order.buyer, order.seller]) await notify(who, { title: `Dispute decided: ${order.title}`, body: `${decision === 'release' ? 'The freelancer is paid.' : 'The client is refunded.'} ${text}`.slice(0, 200), link: ORDER_LINK(order), category: 'freelance' }, { email: true }).catch(() => {});
  return claimed;
}

module.exports = { publicFreelancer, reputation, myProfile, saveProfile, createService, updateService, setServiceStatus, myServices, publicServices, publicService, orderService, propose, myProposals, receivedProposals, decideProposal, withdrawProposal, myOrders, getOrder, postMessage, cancelOrder, payableMilestone, hold, tellFunded, submitWork, approveWork, autoRelease, askRevision, openDispute, leaveReview, earnings, adminOverview, adminService, resolveDispute, TYPES: FreelanceProfile.TYPES, CATEGORIES: FreelanceService.CATEGORIES };
