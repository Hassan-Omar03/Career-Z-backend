const mongoose = require('mongoose');
const AppError = require('../utils/AppError');
const { notify } = require('./notification.service');

// Super Admin Comments & Ratings Management (master, Super Admin dashboard 2): every public
// rating and comment on CareerZ in one place, with hide / show / edit / delete, institute-wise
// averages and monthly graphs. Ratings stay automatic (no per-post approval); the admin only
// steps in afterwards. A hidden rating leaves every public list and average.

const fail = (message, status = 422) => new AppError(message, status);
const SOURCES = {
  product: { label: 'Marketplace product', model: 'Review', author: 'buyer', text: 'comment', target: (r) => r.product?.title || 'Product', populate: [['product', 'title'], ['buyer', 'fullName email'], ['seller', 'fullName']], reported: { reported: true } },
  company: { label: 'Company (employer)', model: 'CompanyReview', author: 'reviewer', text: 'comment', target: (r) => r.employer?.fullName || 'Employer', populate: [['employer', 'fullName'], ['reviewer', 'fullName email']], reported: { 'report.open': true } },
  institution: { label: 'Institute (parent rating)', model: 'InstitutionFeedback', author: 'fromUser', text: 'comment', target: (r) => r.institution?.name || 'Institute', populate: [['institution', 'name city'], ['fromUser', 'fullName email']] },
  teacher: { label: 'Teacher', model: 'TeacherFeedback', author: 'fromUser', text: 'comment', target: (r) => `${r.teacher?.fullName || 'Teacher'}${r.institution?.name ? ` (${r.institution.name})` : ''}`, populate: [['teacher', 'fullName'], ['fromUser', 'fullName email'], ['institution', 'name']] }
};
const M = (key) => require(`../models/${SOURCES[key].model}`);
const src = (key) => { if (!SOURCES[key]) throw fail('Unknown rating type.', 404); return SOURCES[key]; };
// CompanyReview has its own status (pending / published / hidden); the others use `hidden`.
const isHidden = (key, r) => (key === 'company' ? r.status === 'hidden' : Boolean(r.hidden));
const hiddenQ = (key, hidden) => (key === 'company' ? (hidden ? { status: 'hidden' } : { status: { $ne: 'hidden' } }) : (hidden ? { hidden: true } : { hidden: { $ne: true } }));
const visibleQ = (key) => (key === 'company' ? { status: 'published' } : { hidden: { $ne: true } });

function row(key, r) {
  const s = SOURCES[key];
  const author = r[s.author];
  return {
    source: key, sourceLabel: s.label, _id: r._id, target: s.target(r), rating: r.rating,
    sellerRating: r.sellerRating ?? null, text: r[s.text] || '', author: author ? { _id: author._id, fullName: author.fullName, email: author.email } : null,
    fromRole: r.fromRole || '', hidden: isHidden(key, r), status: key === 'company' ? r.status : (r.hidden ? 'hidden' : 'visible'),
    reported: key === 'product' ? Boolean(r.reported) : key === 'company' ? Boolean(r.report?.open) : false,
    reportReason: r.reportReason || r.report?.reason || '', moderation: r.moderation || null, createdAt: r.createdAt
  };
}

async function list(query = {}) {
  const keys = query.source && query.source !== 'all' ? [src(query.source) && query.source] : Object.keys(SOURCES);
  const limit = Math.min(Number(query.limit) || 50, 200);
  const rows = [];
  for (const key of keys) {
    const s = SOURCES[key];
    const q = {};
    if (query.status === 'hidden') Object.assign(q, hiddenQ(key, true));
    else if (query.status === 'visible') Object.assign(q, hiddenQ(key, false));
    if (query.status === 'reported') { if (!s.reported) continue; Object.assign(q, s.reported); }
    if (query.rating) q.rating = Number(query.rating);
    if (query.institution && mongoose.isValidObjectId(query.institution)) { if (!['institution', 'teacher'].includes(key)) continue; q.institution = query.institution; }
    if (query.q) q[s.text] = { $regex: String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80), $options: 'i' };
    let find = M(key).find(q).sort({ createdAt: -1 }).limit(limit);
    for (const [path, select] of s.populate) find = find.populate(path, select);
    rows.push(...(await find.lean()).map((r) => row(key, r)));
  }
  return rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
}

async function moderate(admin, key, id, body = {}) {
  const s = src(key);
  if (!mongoose.isValidObjectId(id)) throw fail('Rating not found.', 404);
  const doc = await M(key).findById(id);
  if (!doc) throw fail('Rating not found.', 404);
  const action = String(body.action || '');
  const note = String(body.note || '').trim().slice(0, 300);
  const authorId = doc[s.author];
  const mod = { by: admin._id, at: new Date(), note, edited: Boolean(doc.moderation?.edited) };
  if (action === 'delete') {
    if (!note) throw fail('Say why the rating is deleted.');
    await doc.deleteOne();
    if (authorId) await notify(authorId, { type: 'system', title: 'Your rating was removed', message: `CareerZ removed your ${s.label.toLowerCase()} rating: ${note}` }).catch(() => {});
    return { deleted: true };
  }
  if (action === 'hide' || action === 'show') {
    if (action === 'hide' && !note) throw fail('Say why the rating is hidden.');
    if (key === 'company') { doc.status = action === 'hide' ? 'hidden' : 'published'; if (doc.report) doc.report.open = false; } else { doc.hidden = action === 'hide'; if (key === 'product') doc.reported = false; }
    if (action === 'hide' && authorId) await notify(authorId, { type: 'system', title: 'Your rating was hidden', message: `CareerZ hid your ${s.label.toLowerCase()} rating: ${note}` }).catch(() => {});
  } else if (action === 'edit') {
    const text = String(body.text ?? '').trim();
    if (text.length > 2000) throw fail('Keep the comment under 2000 characters.');
    if (key === 'company' && text.length < 5) throw fail('A company review needs a comment.');
    doc[s.text] = text;
    mod.edited = true;
  } else if (action === 'dismiss_report') {
    if (key === 'company') doc.report.open = false; else if (key === 'product') doc.reported = false;
  } else throw fail('Choose hide, show, edit, dismiss_report or delete.');
  doc.moderation = key === 'company' ? { by: mod.by, at: mod.at, note: mod.edited ? `${note}${note ? ' · ' : ''}edited by CareerZ` : note } : mod;
  await doc.save();
  const again = await M(key).findById(id).populate(s.populate.map(([path, select]) => ({ path, select }))).lean();
  return row(key, again);
}

const monthKey = { $dateToString: { format: '%Y-%m', date: '$createdAt' } };
async function report(query = {}) {
  const months = Math.min(Math.max(Number(query.months) || 12, 1), 36);
  const now = new Date(), since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const totals = {}, monthly = {};
  for (const key of Object.keys(SOURCES)) {
    const [all] = await M(key).aggregate([{ $group: { _id: null, count: { $sum: 1 }, avg: { $avg: '$rating' }, hidden: { $sum: { $cond: [key === 'company' ? { $eq: ['$status', 'hidden'] } : { $eq: ['$hidden', true] }, 1, 0] } } } }]);
    const stars = await M(key).aggregate([{ $match: visibleQ(key) }, { $group: { _id: '$rating', n: { $sum: 1 } } }]);
    totals[key] = { label: SOURCES[key].label, count: all?.count || 0, hidden: all?.hidden || 0, average: all?.avg ? Number(all.avg.toFixed(2)) : null, stars: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, stars.find((x) => x._id === n)?.n || 0])) };
    const m = await M(key).aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: monthKey, count: { $sum: 1 }, avg: { $avg: '$rating' } } }]);
    for (const x of m) { monthly[x._id] = monthly[x._id] || { month: x._id }; monthly[x._id][key] = { count: x.count, average: Number(x.avg.toFixed(2)) }; }
  }
  const timeline = [];
  for (let i = 0; i < months; i += 1) { const k = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth() + i, 1)).toISOString().slice(0, 7); timeline.push(monthly[k] || { month: k }); }

  // Institute-wise: parents' ratings of the institute plus ratings of its teachers.
  const Institution = require('../models/Institution');
  const [inst, teach] = await Promise.all([
    M('institution').aggregate([{ $match: { hidden: { $ne: true } } }, { $group: { _id: '$institution', avg: { $avg: '$rating' }, n: { $sum: 1 } } }]),
    M('teacher').aggregate([{ $match: { hidden: { $ne: true }, institution: { $ne: null } } }, { $group: { _id: '$institution', avg: { $avg: '$rating' }, n: { $sum: 1 } } }])
  ]);
  const ids = [...new Set([...inst, ...teach].map((x) => String(x._id)))];
  const names = new Map((await Institution.find({ _id: { $in: ids } }).select('name city').lean()).map((i) => [String(i._id), i]));
  const institutions = ids.map((id) => {
    const a = inst.find((x) => String(x._id) === id), t = teach.find((x) => String(x._id) === id);
    return { _id: id, name: names.get(id)?.name || 'Institute', city: names.get(id)?.city || '', instituteAverage: a ? Number(a.avg.toFixed(2)) : null, instituteCount: a?.n || 0, teacherAverage: t ? Number(t.avg.toFixed(2)) : null, teacherCount: t?.n || 0 };
  }).sort((x, y) => (y.instituteCount + y.teacherCount) - (x.instituteCount + x.teacherCount));
  const reported = (await M('product').countDocuments({ reported: true, hidden: { $ne: true } })) + (await M('company').countDocuments({ 'report.open': true }));
  return { totals, timeline, institutions, reported };
}

module.exports = { SOURCES, list, moderate, report };
