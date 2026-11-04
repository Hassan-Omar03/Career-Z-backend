const mongoose = require('mongoose');
const CommissionRule = require('../models/CommissionRule');
const AppError = require('../utils/AppError');

const { SCOPES, SERVICES } = CommissionRule;
const WEIGHT = { product: 5, institution: 4, category: 3, country: 2, global: 1 };
const fail = (m, s = 422) => new AppError(m, s);
const snapshot = (r) => ({ name: r.name, scope: r.scope, scopeValue: r.scopeValue, serviceType: r.serviceType, percentage: r.percentage, fixedFee: r.fixedFee, effectiveFrom: r.effectiveFrom, effectiveUntil: r.effectiveUntil, status: r.status });

// Which rate setting belongs to which service.
function serviceOf(settingKey) {
  const key = String(settingKey || '').split(':')[0];
  return {
    fee_commission_percent: 'tuition', institution_fee_commission_percent: 'tuition', course_commission_percent: 'course', tutoring_commission_percent: 'tutoring',
    marketplace_commission_percent: 'marketplace', recruitment_platform_fee_percent: 'recruitment', donation_commission_percent: 'donation', scholarship_commission_percent: 'scholarship', freelance_commission_percent: 'freelance'
  }[key] || null;
}

const matches = (rule, ctx) => {
  if (rule.scope === 'global') return true;
  const value = ctx[rule.scope];
  return value != null && String(value).toLowerCase() === String(rule.scopeValue).toLowerCase();
};

// The most specific active rule in force today for this payment, or null.
async function bestRule(serviceType, ctx = {}, session = null) {
  if (!serviceType) return null;
  const now = new Date();
  const query = CommissionRule.find({ serviceType, status: 'active', $and: [{ $or: [{ effectiveFrom: null }, { effectiveFrom: { $lte: now } }] }, { $or: [{ effectiveUntil: null }, { effectiveUntil: { $gte: now } }] }] }).sort({ createdAt: -1 }).lean();
  if (session) query.session(session);
  const rows = (await query).filter((r) => matches(r, ctx));
  return rows.sort((a, b) => WEIGHT[b.scope] - WEIGHT[a.scope])[0] || null;
}

function clean(body, current = {}) {
  const v = { ...snapshot(current), ...body };
  if (!SCOPES.includes(v.scope)) throw fail('Choose a valid scope.');
  if (!SERVICES.includes(v.serviceType)) throw fail('Choose a valid service.');
  const percentage = Number(v.percentage), fixedFee = Number(v.fixedFee || 0);
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw fail('The percentage must be from 0 to 100.');
  if (!Number.isFinite(fixedFee) || fixedFee < 0) throw fail('The fixed fee cannot be negative.');
  const scopeValue = v.scope === 'global' ? '' : String(v.scopeValue || '').trim();
  if (v.scope !== 'global' && !scopeValue) throw fail('Choose the country, institution, category or product this rule is for.');
  if (['institution', 'product'].includes(v.scope) && !mongoose.isValidObjectId(scopeValue)) throw fail('Choose a valid institution or product.');
  const date = (d, label) => { if (!d) return null; const x = new Date(d); if (Number.isNaN(x.getTime())) throw fail(`${label} is not a valid date.`); return x; };
  const effectiveFrom = date(v.effectiveFrom, 'The start date'), effectiveUntil = date(v.effectiveUntil, 'The end date');
  if (effectiveFrom && effectiveUntil && effectiveUntil < effectiveFrom) throw fail('The end date is before the start date.');
  return { name: String(v.name || '').trim().slice(0, 120), scope: v.scope, scopeValue: v.scope === 'country' ? scopeValue.toUpperCase() : scopeValue, serviceType: v.serviceType, percentage, fixedFee, effectiveFrom, effectiveUntil };
}

async function assertNoClash(rule, ignoreId = null) {
  const filter = { serviceType: rule.serviceType, scope: rule.scope, scopeValue: rule.scopeValue, status: 'active' };
  if (ignoreId) filter._id = { $ne: ignoreId };
  const end = rule.effectiveUntil || new Date(8640000000000000), start = rule.effectiveFrom || new Date(0);
  const clash = (await CommissionRule.find(filter).lean()).find((r) => (r.effectiveFrom || new Date(0)) <= end && (r.effectiveUntil || new Date(8640000000000000)) >= start);
  if (clash) throw fail(`An active rule already covers this service and scope in those dates${clash.name ? `: ${clash.name}` : ''}.`, 409);
}

const list = () => CommissionRule.find().populate('history.by', 'fullName').populate('createdBy', 'fullName').sort({ status: 1, serviceType: 1, createdAt: -1 }).lean();
async function create(admin, body) {
  const value = clean(body);
  await assertNoClash(value);
  return CommissionRule.create({ ...value, status: 'active', createdBy: admin._id, history: [{ action: 'created', after: value, by: admin._id }] });
}
async function update(admin, id, body) {
  const rule = mongoose.isValidObjectId(id) ? await CommissionRule.findById(id) : null;
  if (!rule) throw fail('Rule not found.', 404);
  const value = clean(body, rule);
  if (rule.status === 'active') await assertNoClash(value, rule._id);
  const before = snapshot(rule);
  Object.assign(rule, value);
  rule.history.push({ action: 'updated', before, after: snapshot(rule), by: admin._id });
  return rule.save();
}
async function setStatus(admin, id, status) {
  if (!['active', 'inactive'].includes(status)) throw fail('Choose active or inactive.');
  const rule = mongoose.isValidObjectId(id) ? await CommissionRule.findById(id) : null;
  if (!rule) throw fail('Rule not found.', 404);
  if (rule.status === status) return rule;
  if (status === 'active') await assertNoClash(snapshot(rule), rule._id);
  const before = snapshot(rule);
  rule.status = status;
  rule.history.push({ action: status === 'active' ? 'enabled' : 'disabled', before, after: snapshot(rule), by: admin._id });
  return rule.save();
}

module.exports = { serviceOf, bestRule, list, create, update, setStatus, SCOPES, SERVICES };
