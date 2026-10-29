const mongoose = require('mongoose');
const Ad = require('../models/Ad');
const Setting = require('../models/Setting');
const Institution = require('../models/Institution');
const AppError = require('../utils/AppError');

// Super Admin Ad Management (master, Super Admin dashboard 16):
//   global on/off and per-placement on/off; ads may run on the public home, blog, course,
//   institute, job and marketplace lists and on dashboards, and NEVER on a live class, exam,
//   chat, wallet or payment screen (the dashboard decides the screen; these are never placements);
//   an institute can pay (monthly or yearly) to turn ads off on its own people's dashboards.

const fail = (message, status = 422) => new AppError(message, status);
const KEY = 'ads_config';
const PLACEMENTS = ['home', 'blog', 'courses', 'institutes', 'jobs', 'marketplace', 'dashboard'];
const NEVER = ['live_class', 'exam', 'chat', 'wallet', 'payment'];
const DEFAULTS = { enabled: false, placements: Object.fromEntries(PLACEMENTS.map((p) => [p, true])), adFree: { monthly: 2000, yearly: 20000, currency: 'PKR' } };
const IMG = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

async function config() {
  const s = await Setting.findOne({ key: KEY }).lean();
  const v = s?.value || {};
  return { enabled: v.enabled ?? DEFAULTS.enabled, placements: { ...DEFAULTS.placements, ...(v.placements || {}) }, adFree: { ...DEFAULTS.adFree, ...(v.adFree || {}) }, never: NEVER };
}
async function setConfig(admin, body = {}) {
  if (!admin.roles?.includes('super_admin')) throw fail('Only the Super Admin controls ads.', 403);
  const cur = await config();
  const placements = { ...cur.placements };
  for (const p of PLACEMENTS) if (body.placements?.[p] !== undefined) placements[p] = Boolean(body.placements[p]);
  const num = (v, d) => { const n = Number(v); if (v === undefined) return d; if (!Number.isFinite(n) || n < 0) throw fail('Prices cannot be negative.'); return Math.round(n); };
  const value = { enabled: body.enabled === undefined ? cur.enabled : Boolean(body.enabled), placements, adFree: { monthly: num(body.adFree?.monthly, cur.adFree.monthly), yearly: num(body.adFree?.yearly, cur.adFree.yearly), currency: 'PKR' } };
  await Setting.findOneAndUpdate({ key: KEY }, { $set: { value, updatedBy: admin._id } }, { upsert: true });
  return config();
}

function clean(body, existing) {
  const out = {};
  if (body.title !== undefined || !existing) { out.title = String(body.title || '').trim().slice(0, 100); if (out.title.length < 2) throw fail('Give the ad a title.'); }
  if (body.advertiser !== undefined) out.advertiser = String(body.advertiser || '').trim().slice(0, 100);
  if (body.text !== undefined) out.text = String(body.text || '').trim().slice(0, 300);
  if (body.link !== undefined || !existing) { out.link = String(body.link || '').trim(); if (!/^https:\/\//.test(out.link)) throw fail('The ad link must start with https://.'); }
  if (body.image !== undefined) {
    const img = String(body.image || '');
    if (img && !/^https:\/\//.test(img) && !IMG.test(img)) throw fail('The image must be an https link or a PNG, JPG, WEBP or GIF upload.');
    if (img.length > 900000) throw fail('The image is too large; use one under about 600 KB.');
    out.image = img;
  }
  if (body.placements !== undefined || !existing) {
    const list = [].concat(body.placements || []);
    if (list.some((p) => NEVER.includes(p))) throw fail('Ads never run on live classes, exams, chat, wallet or payment screens.');
    out.placements = [...new Set(list.filter((p) => PLACEMENTS.includes(p)))];
    if (!out.placements.length) throw fail('Choose where the ad runs.');
  }
  for (const k of ['startsAt', 'endsAt']) if (body[k] !== undefined) { out[k] = body[k] ? new Date(body[k]) : null; if (out[k] && Number.isNaN(out[k].getTime())) throw fail('Choose valid dates.'); }
  if (body.active !== undefined) out.active = Boolean(body.active);
  return out;
}
async function list() { return Ad.find().select('-image').sort({ createdAt: -1 }).lean(); }
async function get(id) { if (!mongoose.isValidObjectId(id)) throw fail('Ad not found.', 404); const a = await Ad.findById(id).lean(); if (!a) throw fail('Ad not found.', 404); return a; }
async function create(admin, body) { if (!admin.roles?.includes('super_admin')) throw fail('Only the Super Admin creates ads.', 403); return Ad.create({ ...clean(body || {}, null), createdBy: admin._id }); }
async function update(admin, id, body) {
  if (!admin.roles?.includes('super_admin')) throw fail('Only the Super Admin edits ads.', 403);
  const a = await Ad.findById(mongoose.isValidObjectId(id) ? id : null);
  if (!a) throw fail('Ad not found.', 404);
  Object.assign(a, clean(body || {}, a));
  await a.save();
  return a;
}
async function remove(admin, id) { if (!admin.roles?.includes('super_admin')) throw fail('Only the Super Admin deletes ads.', 403); await Ad.deleteOne({ _id: id }); return { deleted: true }; }

// Dashboards: no ads for people of an institute that bought ad-free time.
async function adFreeFor(user) {
  if (!user) return false;
  const now = new Date();
  const own = await Institution.exists({ adFreeUntil: { $gt: now }, $or: [{ owner: user._id }, { 'staff.user': user._id }] });
  if (own) return true;
  const ids = await require('../models/StudentInstitutionMembership').distinct('institution', { student: user._id, status: 'active' });
  return Boolean(ids.length && await Institution.exists({ _id: { $in: ids }, adFreeUntil: { $gt: now } }));
}

// One ad for a placement (random among the running ones), counted as seen.
async function slot(placement, user) {
  if (NEVER.includes(placement) || !PLACEMENTS.includes(placement)) return null;
  const cfg = await config();
  if (!cfg.enabled || !cfg.placements[placement]) return null;
  if (placement === 'dashboard' && await adFreeFor(user)) return null;
  const now = new Date();
  const rows = await Ad.find({ active: true, placements: placement, $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }] }).select('_id').lean();
  if (!rows.length) return null;
  const pick = rows[Math.floor(Math.random() * rows.length)];
  const ad = await Ad.findByIdAndUpdate(pick._id, { $inc: { impressions: 1 } }, { new: true }).select('title advertiser text image link').lean();
  return ad;
}
async function click(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const a = await Ad.findByIdAndUpdate(id, { $inc: { clicks: 1 } }, { new: true }).select('link').lean();
  return a?.link || null;
}

// Ad-free time bought by an institute (ManualPayment kind 'ad_free', CareerZ is the seller).
async function resolveAdFree(user, institutionId, body = {}) {
  if (!mongoose.isValidObjectId(institutionId)) throw fail('Institute not found.', 404);
  const inst = await Institution.findById(institutionId).select('owner name');
  if (!inst) throw fail('Institute not found.', 404);
  if (String(inst.owner) !== String(user._id)) throw fail('Only the institute owner can buy ad-free time.', 403);
  const cfg = await config();
  const period = body.period === 'yearly' ? 'yearly' : 'monthly';
  const price = cfg.adFree[period];
  if (!(price > 0)) throw fail('Ad-free time has no price yet.', 503);
  return { title: `Ad-free dashboards for ${inst.name} (${period === 'yearly' ? '1 year' : '1 month'})`, price, currency: 'PKR', recipient: null, refs: { institution: inst._id, plan: `ad_free_${period}` }, openSuffix: `${inst._id}:${period}` };
}
async function grantAdFree(mp, session) {
  const inst = await Institution.findById(mp.institution).session(session);
  const days = mp.plan === 'ad_free_yearly' ? 365 : 30;
  const from = inst.adFreeUntil && inst.adFreeUntil > new Date() ? inst.adFreeUntil : new Date();
  inst.adFreeUntil = new Date(from.getTime() + days * 864e5);
  await inst.save({ session });
}
async function adFreeInstitutions() {
  return Institution.find({ adFreeUntil: { $gt: new Date() } }).select('name city adFreeUntil').sort({ adFreeUntil: -1 }).lean();
}
async function myAdFree(user) {
  return Institution.find({ owner: user._id }).select('name adFreeUntil').lean();
}

module.exports = { PLACEMENTS, NEVER, config, setConfig, list, get, create, update, remove, slot, click, resolveAdFree, grantAdFree, adFreeInstitutions, myAdFree, adFreeFor };
