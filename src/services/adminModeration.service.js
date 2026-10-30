const mongoose = require('mongoose');
const AppError = require('../utils/AppError');
const { notify } = require('./notification.service');

// Super Admin moderation after publishing: posts go live automatically, and an admin can still
// remove any job (institute, employer or agent), marketplace product (fake, or priced far above the
// market) or scholarship that looks fake or suspicious. A removed item disappears from every
// public list, its owner sees "Removed by CareerZ admin" with the reason and cannot re-publish it,
// and applicants of a removed job are warned. The admin can restore it.
// Also: one place to look up any user with their full details.

const fail = (message, status = 422) => new AppError(message, status);
const M = (n) => require(`../models/${n}`);
const OWNER = 'fullName email phone roles status city country';
const KINDS = {
  job: { model: 'Job', label: 'job', owner: 'postedBy', live: 'active', fields: 'title company city country type status salaryMin salaryMax currency createdAt adminRemoval institution', text: ['title', 'company', 'description'] },
  product: { model: 'Product', label: 'product', owner: 'seller', live: 'active', fields: 'title category price currency stock status createdAt adminRemoval images', text: ['title', 'description', 'category'] },
  scholarship: { model: 'Scholarship', label: 'scholarship', owner: 'donor', alsoOwner: 'publishedBy', live: 'open', fields: 'title amount currency country status createdAt adminRemoval applicationDeadline donor publishedBy provider', text: ['title', 'description'] }
};
const kindOf = (k) => { if (!KINDS[k]) throw fail('Choose job, product or scholarship.', 404); return KINDS[k]; };
const rx = (q) => ({ $regex: String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80), $options: 'i' });

async function search(query = {}) {
  const k = kindOf(query.kind || 'job');
  const filter = {};
  if (query.status === 'removed') filter.status = 'removed_by_admin';
  else if (query.status === 'live') filter.status = k.live;
  else filter.status = { $nin: ['removed'] };
  if (query.q) filter.$or = k.text.map((f) => ({ [f]: rx(query.q) }));
  let find = M(k.model).find(filter).select(k.fields + ' ' + k.owner).sort({ createdAt: -1 }).limit(Math.min(Number(query.limit) || 50, 200)).populate(k.owner, OWNER);
  if (k.alsoOwner) find = find.populate(k.alsoOwner, OWNER);
  const rows = await find.lean();
  return rows.map((r) => {
    const owner = r[k.owner] || (k.alsoOwner && r[k.alsoOwner]) || null;
    const image = (r.images || []).find((u) => /^https:\/\//.test(u)) || null;
    return { kind: query.kind || 'job', _id: r._id, title: r.title, company: r.company || r.provider?.name || '', category: r.category || r.type || '', price: r.price ?? r.amount ?? null, salary: r.salaryMin || r.salaryMax ? [r.salaryMin, r.salaryMax].filter(Boolean).join(' – ') : '', currency: r.currency || 'PKR', status: r.status, createdAt: r.createdAt, place: [r.city, r.country].filter(Boolean).join(', '), image, adminRemoval: r.status === 'removed_by_admin' ? r.adminRemoval : null, owner: owner ? { _id: owner._id, fullName: owner.fullName, email: owner.email, phone: owner.phone || '', roles: owner.roles } : null };
  });
}

async function remove(admin, kind, id, body = {}) {
  const k = kindOf(kind);
  const reason = String(body.reason || '').trim().slice(0, 500);
  if (reason.length < 5) throw fail('Write why it is being removed. The owner will see it.');
  const doc = await M(k.model).findById(mongoose.isValidObjectId(id) ? id : null);
  if (!doc) throw fail('Not found.', 404);
  if (doc.status === 'removed_by_admin') throw fail('Already removed.', 409);
  doc.adminRemoval = { by: admin._id, at: new Date(), reason, previousStatus: doc.status };
  doc.status = 'removed_by_admin';
  await doc.save();
  const owners = [doc[k.owner], k.alsoOwner && doc[k.alsoOwner]].filter(Boolean).map(String);
  for (const o of new Set(owners)) {
    await notify(o, { title: `Your ${k.label} was removed by CareerZ admin`, body: `"${doc.title}" was removed. Reason: ${reason}`, link: '/dashboard' }, { email: true }).catch(() => {});
  }
  if (kind === 'job') {
    const apps = await M('JobApplication').find({ job: doc._id, status: { $nin: ['withdrawn', 'rejected', 'hired'] } }).select('applicant').lean();
    for (const a of apps) await notify(a.applicant, { title: 'A job you applied to was removed', body: `CareerZ removed "${doc.title}" (${doc.company}). Do not share documents or pay anyone for this job.`, link: '/dashboard' }).catch(() => {});
  }
  if (kind === 'product') {
    // Unpaid orders of a removed product are cancelled and the stock is not sold any more.
    await M('Order').updateMany({ product: doc._id, paymentStatus: { $ne: 'paid' }, status: 'pending' }, { $set: { status: 'cancelled' }, $push: { timeline: { status: 'cancelled', at: new Date(), by: admin._id, note: 'Listing removed by CareerZ admin' } } }).catch(() => {});
  }
  return { removed: true, status: doc.status, adminRemoval: doc.adminRemoval };
}

async function restore(admin, kind, id) {
  const k = kindOf(kind);
  const doc = await M(k.model).findById(mongoose.isValidObjectId(id) ? id : null);
  if (!doc) throw fail('Not found.', 404);
  if (doc.status !== 'removed_by_admin') throw fail('It is not removed.', 409);
  doc.status = doc.adminRemoval?.previousStatus || k.live;
  doc.adminRemoval = { by: null, at: null, reason: '', previousStatus: '' };
  await doc.save();
  const owner = doc[k.owner] || (k.alsoOwner && doc[k.alsoOwner]);
  if (owner) await notify(owner, { title: `Your ${k.label} is back`, body: `CareerZ admin restored "${doc.title}".`, link: '/dashboard' }).catch(() => {});
  return { restored: true, status: doc.status };
}

// ---------------------------------------------------------------- users
async function users(query = {}) {
  const filter = {};
  if (query.role) filter.roles = String(query.role);
  if (['active', 'suspended', 'disabled'].includes(query.status)) filter.status = query.status;
  if (query.q) { const r = rx(query.q); filter.$or = [{ fullName: r }, { email: r }, { phone: r }, { city: r }]; }
  const limit = Math.min(Number(query.limit) || 50, 200), page = Math.max(1, Number(query.page) || 1);
  const [rows, total] = await Promise.all([
    M('User').find(filter).select('fullName email phone phoneVerified emailVerified roles status city country createdAt lastLoginAt').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    M('User').countDocuments(filter)
  ]);
  const ids = rows.map((u) => u._id);
  const reqs = await M('RoleRequest').find({ user: { $in: ids } }).select('user requestedRole status subtype').lean();
  return { total, page, pages: Math.ceil(total / limit) || 1, users: rows.map((u) => ({ ...u, requests: reqs.filter((r) => String(r.user) === String(u._id)).map((r) => ({ role: r.requestedRole, status: r.status, subtype: r.subtype })) })) };
}

async function userDetail(id) {
  if (!mongoose.isValidObjectId(id)) throw fail('User not found.', 404);
  const user = await M('User').findById(id).select('-passwordHash -mfaSecret -recoveryCodes').lean();
  if (!user) throw fail('User not found.', 404);
  const safe = async (fn, d) => { try { return await fn(); } catch { return d; } };
  const [requests, profiles, documents, institutions, jobs, applications, products, ordersBought, ordersSold, scholarships, children, wallets, payments] = await Promise.all([
    safe(() => M('RoleRequest').find({ user: id }).select('requestedRole subtype status createdAt approvedAt reviewNote').lean(), []),
    safe(() => M('UserProfile').find({ user: id }).select('role fields percent completed').lean(), []),
    safe(() => M('VerificationDocument').find({ user: id }).select('role documentType originalName contentType size status createdAt').sort({ createdAt: -1 }).lean(), []),
    safe(() => M('Institution').find({ $or: [{ owner: id }, { 'staff.user': id }] }).select('name type city verificationStatus owner').lean(), []),
    safe(() => M('Job').find({ postedBy: id }).select('title company status createdAt').sort({ createdAt: -1 }).limit(20).lean(), []),
    safe(() => M('JobApplication').countDocuments({ applicant: id }), 0),
    safe(() => M('Product').find({ seller: id, status: { $ne: 'removed' } }).select('title price currency status').sort({ createdAt: -1 }).limit(20).lean(), []),
    safe(() => M('Order').countDocuments({ buyer: id }), 0),
    safe(() => M('Order').countDocuments({ seller: id }), 0),
    safe(() => M('Scholarship').find({ $or: [{ donor: id }, { publishedBy: id }] }).select('title status amount currency').limit(20).lean(), []),
    safe(() => M('ParentChildLink').find({ $or: [{ parent: id }, { student: id }] }).populate('parent', 'fullName email').populate('student', 'fullName email').select('parent student relationship status').lean(), []),
    safe(() => M('Wallet').find({ user: id }).lean(), []),
    safe(() => M('ManualPayment').find({ $or: [{ payer: id }, { recipient: id }] }).select('number kind title status currency commission sellerAmount createdAt').sort({ createdAt: -1 }).limit(20).lean(), [])
  ]);
  // Sensitive profile values (CNIC and the like) stay masked; documents open through Verification.
  const mask = (k, v) => (/cnic|passport|b_?form|nic|iban|account/i.test(k) && typeof v === 'string' && v.length > 4 ? `${'•'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}` : v);
  return {
    user, requests,
    profiles: profiles.map((p) => ({ role: p.role, percent: p.percent, completed: p.completed, fields: Object.fromEntries(Object.entries(p.fields || {}).filter(([, v]) => v !== '' && v != null && typeof v !== 'object').map(([k, v]) => [k, mask(k, v)])) })),
    documents, institutions, jobs, products, scholarships, children, wallets, payments,
    counts: { applications, ordersBought, ordersSold, jobs: jobs.length, products: products.length }
  };
}

module.exports = { search, remove, restore, users, userDetail, KINDS };
