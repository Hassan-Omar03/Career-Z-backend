const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Setting = require('../models/Setting');
const AdminResource = require('../models/AdminResource');
const AdminAuditLog = require('../models/AdminAuditLog');
const Fee = require('../models/Fee');
const Order = require('../models/Order');
const WalletTransaction = require('../models/WalletTransaction');
const TransportJourney = require('../models/TransportJourney');
const HealthIncident = require('../models/HealthIncident');
const LoginAttempt = require('../models/LoginAttempt');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const { snapshot } = require('../services/platformMetrics');

const SETTINGS_KEY = 'admin_control_center';
const FAVORITES_PREFIX = 'admin_favorites_';
const RESOURCE_TYPES = new Set(['communication_template', 'tax_rule', 'settlement', 'compliance_request', 'incident', 'task', 'staff_message', 'plugin', 'api_version']);
const defaults = {
  branding: { platformName: 'CareerZ', logoUrl: '', faviconUrl: '', supportEmail: '' },
  theme: { primaryColor: '#123c33', accentColor: '#d59b32', mode: 'system' },
  seo: { title: 'CareerZ', description: '', keywords: '', robots: 'index,follow', socialImageUrl: '' },
  emergency: { maintenanceMode: false, disablePayments: false, disableRegistrations: false, disableAi: false, notice: '' },
  compliance: { privacyEmail: '', retentionDays: 365, gdprEnabled: true },
  versions: { publicApi: 'v1', minimumClient: '1.0.0' }
};

async function readSettings() {
  const record = await Setting.findOne({ key: SETTINGS_KEY });
  const value = record?.value || {};
  return Object.fromEntries(Object.entries(defaults).map(([key, val]) => [key, { ...val, ...(value[key] || {}) }]));
}

const getSettings = asyncHandler(async (req, res) => ok(res, await readSettings()));
const updateSettings = asyncHandler(async (req, res) => {
  const section = req.params.section;
  if (!defaults[section]) throw new AppError('Unknown settings section.', 404);
  const current = await readSettings();
  current[section] = { ...current[section], ...(req.body || {}) };
  await Setting.findOneAndUpdate({ key: SETTINGS_KEY }, { key: SETTINGS_KEY, value: current }, { upsert: true, new: true });
  return ok(res, current[section], `${section} settings updated.`);
});

const listResources = asyncHandler(async (req, res) => {
  if (!RESOURCE_TYPES.has(req.params.type)) throw new AppError('Unknown resource type.', 404);
  const filter = { type: req.params.type };
  if (req.query.status) filter.status = req.query.status;
  const rows = await AdminResource.find(filter).populate('assignedTo createdBy updatedBy', 'fullName email').sort({ createdAt: -1 }).limit(500);
  return ok(res, rows);
});
const createResource = asyncHandler(async (req, res) => {
  if (!RESOURCE_TYPES.has(req.params.type)) throw new AppError('Unknown resource type.', 404);
  if (!req.body.title?.trim()) throw new AppError('title is required.', 422);
  const row = await AdminResource.create({ type: req.params.type, key: req.body.key || '', title: req.body.title.trim(), status: req.body.status || 'active', data: req.body.data || {}, assignedTo: req.body.assignedTo || null, createdBy: req.user._id, updatedBy: req.user._id });
  return created(res, row);
});
const updateResource = asyncHandler(async (req, res) => {
  const row = await AdminResource.findById(req.params.id);
  if (!row || row.type !== req.params.type) throw new AppError('Record not found.', 404);
  for (const field of ['title', 'status', 'data', 'assignedTo', 'key']) if (req.body[field] !== undefined) row[field] = req.body[field];
  row.updatedBy = req.user._id;
  await row.save();
  return ok(res, row, 'Record updated.');
});
const deleteResource = asyncHandler(async (req, res) => {
  const row = await AdminResource.findById(req.params.id);
  if (!row || row.type !== req.params.type) throw new AppError('Record not found.', 404);
  await row.deleteOne();
  return ok(res, null, 'Record removed.');
});

const monitoring = asyncHandler(async (req, res) => {
  const db = mongoose.connection.db;
  const dbStats = db ? await db.stats().catch(() => null) : null;
  return ok(res, { ...snapshot(req.query.minutes), database: dbStats ? { collections: dbStats.collections, dataSizeMB: Number((dbStats.dataSize / 1048576).toFixed(2)), storageSizeMB: Number((dbStats.storageSize / 1048576).toFixed(2)) } : null });
});

const auditLogs = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.actor) filter.actor = req.query.actor;
  if (req.query.action) filter.action = { $regex: req.query.action, $options: 'i' };
  const rows = await AdminAuditLog.find(filter).populate('actor', 'fullName email roles').sort({ createdAt: -1 }).limit(Math.min(500, Number(req.query.limit) || 100));
  return ok(res, rows);
});

const financeAudit = asyncHandler(async (req, res) => {
  const [fees, orders, ledger, settlements] = await Promise.all([
    Fee.find().select('amount currency status paymentMethod transactionId refund escrowStatus createdAt').sort({ createdAt: -1 }).limit(500),
    Order.find().select('totalPrice currency status paymentStatus refundRequested createdAt').sort({ createdAt: -1 }).limit(500),
    WalletTransaction.find().sort({ createdAt: -1 }).limit(500),
    AdminResource.find({ type: 'settlement' }).sort({ createdAt: -1 }).limit(500)
  ]);
  const totals = fees.reduce((out, fee) => { const key = `${fee.currency}:${fee.status}`; out[key] = (out[key] || 0) + fee.amount; return out; }, {});
  return ok(res, { totals, fees, orders, ledger, settlements });
});

const refunds = asyncHandler(async (req, res) => {
  const [fees, orders] = await Promise.all([
    Fee.find({ 'refund.status': { $ne: 'none' } }).populate('student', 'fullName email').populate('institution', 'name').sort({ 'refund.requestedAt': -1 }),
    Order.find({ $or: [{ refundRequested: true }, { status: 'refunded' }] }).populate('buyer seller', 'fullName email').populate('product', 'title').sort({ updatedAt: -1 })
  ]);
  return ok(res, { fees, orders });
});

const childSafety = asyncHandler(async (req, res) => {
  const [journeys, incidents] = await Promise.all([
    TransportJourney.find({ $or: [{ sosActive: true }, { status: 'active' }] }).populate('institution vehicle').sort({ updatedAt: -1 }).limit(100),
    HealthIncident.find().populate('institution student', 'name fullName').sort({ occurredAt: -1 }).limit(100)
  ]);
  return ok(res, { journeys, incidents });
});

const anomalies = asyncHandler(async (req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [failedByIp, largeTransfers, repeatedRefunds] = await Promise.all([
    LoginAttempt.aggregate([{ $match: { success: false, createdAt: { $gte: since } } }, { $group: { _id: '$ip', count: { $sum: 1 } } }, { $match: { count: { $gte: 5 } } }, { $sort: { count: -1 } }]),
    WalletTransaction.find({ createdAt: { $gte: since }, amount: { $gte: Number(req.query.largeAmount) || 1000 } }).populate('user', 'fullName email').sort({ amount: -1 }),
    Fee.aggregate([{ $match: { 'refund.requestedAt': { $gte: since } } }, { $group: { _id: '$paidBy', count: { $sum: 1 } } }, { $match: { count: { $gte: 3 } } }])
  ]);
  return ok(res, { generatedAt: new Date(), rules: { failedLoginThreshold: 5, largeAmount: Number(req.query.largeAmount) || 1000, repeatedRefundThreshold: 3 }, failedByIp, largeTransfers, repeatedRefunds });
});

const getFavorites = asyncHandler(async (req, res) => {
  const row = await Setting.findOne({ key: `${FAVORITES_PREFIX}${req.user._id}` });
  return ok(res, row?.value || []);
});
const saveFavorites = asyncHandler(async (req, res) => {
  if (!Array.isArray(req.body.items) || req.body.items.length > 20) throw new AppError('items must be an array with at most 20 entries.', 422);
  const items = req.body.items.map(String).map((x) => x.slice(0, 80));
  await Setting.findOneAndUpdate({ key: `${FAVORITES_PREFIX}${req.user._id}` }, { key: `${FAVORITES_PREFIX}${req.user._id}`, value: items }, { upsert: true });
  return ok(res, items, 'Favorites saved.');
});

const restoreBackup = asyncHandler(async (req, res) => {
  const Backup = require('../models/Backup');
  const backup = await Backup.findById(req.params.id);
  if (!backup || backup.status !== 'completed') throw new AppError('Completed backup not found.', 404);
  const root = path.join(__dirname, '..', '..', 'backups', backup.folder);
  const parsed = [];
  for (const collection of backup.collections) {
    const filename = path.join(root, `${collection.name}.json`);
    if (!fs.existsSync(filename)) throw new AppError(`Backup file missing: ${collection.name}.json`, 409);
    const documents = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(documents)) throw new AppError(`Invalid backup file: ${collection.name}.json`, 409);
    parsed.push({ name: collection.name, count: documents.length, documents });
  }
  if (req.body.confirm !== `RESTORE ${backup.id}`) return ok(res, { dryRun: true, confirmationRequired: `RESTORE ${backup.id}`, collections: parsed.map(({ name, count }) => ({ name, count })) }, 'Backup validated. Submit the exact confirmation to restore.');
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const entry of parsed) {
        if (!mongoose.modelNames().includes(entry.name)) continue;
        const Model = mongoose.model(entry.name);
        await Model.deleteMany({}, { session });
        if (entry.documents.length) await Model.insertMany(entry.documents, { session, ordered: false });
      }
    });
  } finally { await session.endSession(); }
  return ok(res, { restored: true, collections: parsed.map(({ name, count }) => ({ name, count })) }, 'Backup restored. Restart workers and verify platform health.');
});

module.exports = { getSettings, updateSettings, listResources, createResource, updateResource, deleteResource, monitoring, auditLogs, financeAudit, refunds, childSafety, anomalies, getFavorites, saveFavorites, restoreBackup };
