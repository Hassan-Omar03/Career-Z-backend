const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'admin-ops-test-secret';

const User = require('../src/models/User');
const Setting = require('../src/models/Setting');
const AdminResource = require('../src/models/AdminResource');
const ctrl = require('../src/controllers/adminOps.controller');
const { metricsMiddleware, snapshot } = require('../src/services/platformMetrics');
let mongo, admin;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all([User, Setting, AdminResource].map((m) => m.init())); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { await Promise.all([User, Setting, AdminResource].map((m) => m.deleteMany({}))); admin = await User.create({ fullName: 'Admin', email: 'admin-ops@example.test', passwordHash: 'unused', roles: ['super_admin'] }); });

function invoke(handler, { body = {}, params = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(v) { status = v; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    Promise.resolve(handler({ body, params, query, user: admin }, res, reject)).catch(reject);
  });
}

test('admin control settings merge defaults and persist section updates', async () => {
  const initial = await invoke(ctrl.getSettings);
  assert.equal(initial.body.data.branding.platformName, 'CareerZ');
  await invoke(ctrl.updateSettings, { params: { section: 'branding' }, body: { platformName: 'CareerZ Global' } });
  const saved = await invoke(ctrl.getSettings);
  assert.equal(saved.body.data.branding.platformName, 'CareerZ Global');
  assert.equal(saved.body.data.branding.logoUrl, '');
});

test('typed admin resources create and list tax rules without mixing types', async () => {
  await invoke(ctrl.createResource, { params: { type: 'tax_rule' }, body: { title: 'Pakistan VAT', key: 'pk-vat', data: { rate: 5 } } });
  await AdminResource.create({ type: 'task', title: 'Other', createdBy: admin._id, updatedBy: admin._id });
  const listed = await invoke(ctrl.listResources, { params: { type: 'tax_rule' } });
  assert.equal(listed.body.data.length, 1);
  assert.equal(listed.body.data[0].data.rate, 5);
});

test('platform metrics record latency and status without request bodies', async () => {
  const listeners = {};
  const req = { method: 'GET', path: '/health', route: { path: '/health' } };
  const res = { statusCode: 200, on(event, fn) { listeners[event] = fn; } };
  metricsMiddleware(req, res, () => {});
  listeners.finish();
  const report = snapshot(60);
  assert.ok(report.requests >= 1);
  assert.equal(report.process.node.startsWith('v'), true);
});
