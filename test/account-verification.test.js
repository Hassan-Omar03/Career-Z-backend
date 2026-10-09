const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Full HTTP flow through the real app: register → upload → submit → admin decision → profile → dashboard.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'verification-test-access-secret';
const notifications = require('../src/services/notification.service');
const notified = [];
const adminAlerts = [];
mock.method(notifications, 'notify', async (userId, payload) => { notified.push({ userId: String(userId), title: payload.title, body: payload.body }); });
mock.method(notifications, 'notifyAdmins', async (payload) => { adminAlerts.push(payload.title); });
const otp = require('../src/services/otp.service');
mock.method(otp, 'issueOtp', async () => {});

const app = require('../src/app');
const env = require('../src/config/env');
const User = require('../src/models/User');
const RoleRequest = require('../src/models/RoleRequest');
const UserProfile = require('../src/models/UserProfile');
const VerificationDocument = require('../src/models/VerificationDocument');
const VerificationDocumentFile = require('../src/models/VerificationDocumentFile');
const VerificationHistory = require('../src/models/VerificationHistory');
const AdminAuditLog = require('../src/models/AdminAuditLog');
const StaffProfile = require('../src/models/StaffProfile');
const cfg = require('../src/config/accountVerification');

const models = [User, RoleRequest, UserProfile, VerificationDocument, VerificationDocumentFile, VerificationHistory, AdminAuditLog, StaffProfile];
let mongo, server, base, admin, adminToken;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(models.map((m) => m.init()));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  notified.length = 0; adminAlerts.length = 0;
  admin = await User.create({ fullName: 'Admin', email: 'admin@verify.test', passwordHash: 'x', roles: ['admin'] });
  adminToken = tokenFor(admin);
});

const tokenFor = (user) => jwt.sign({ sub: String(user._id) }, env.jwt.accessSecret, { expiresIn: '10m' });
async function call(method, path, { token, body, raw, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (raw) { init.body = raw; init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/octet-stream'; }
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(base + path, init);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

// Real file signatures with unique content, so duplicate detection never fires by accident.
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(64)]);
const fileFor = (type) => (cfg.IMAGE_ONLY.has(type) ? png() : pdf());

function validValue(field) {
  if (field.sensitive) return '35202-1234567-1';
  if (field.type === 'select') return field.options[0];
  if (field.type === 'date') return '1990-05-01';
  return { phone: '+923001234567', email: 'person@verify.test', year: '2015', url: 'https://example.test' }[field.pattern] || `${field.label} value`;
}

async function register(accountType, subtype, email = `${accountType}-${subtype || 'x'}@verify.test`) {
  const res = await call('POST', '/auth/register', { body: { fullName: `${accountType} user`, email, password: 'Password123!', accountType, subtype } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token: res.body.data.accessToken, user: res.body.data.user };
}
async function uploadMandatory(token, role, subtype) {
  for (const group of cfg.documentRequirements(role, subtype).filter((g) => g.mandatory !== false)) {
    for (const type of group.anyOf[0]) {
      const res = await call('POST', `/onboarding/documents?role=${role}&type=${type}`, { token, raw: fileFor(type), headers: { 'X-File-Name': `${type}.bin` } });
      assert.equal(res.status, 201, `${role}/${type}: ${JSON.stringify(res.body)}`);
    }
  }
}
const gateState = async (token) => (await call('GET', '/onboarding/status', { token })).body.data.state;
const dashboard = (token) => call('GET', '/wallet/me', { token });

const CASES = [
  ['student', ''], ['parent', ''], ['teacher', ''], ['institute', ''],
  ['agent', 'agency'], ['donor', 'organization'], ['marketplace', 'business'],
  ['donor', 'individual'], ['marketplace', 'individual'], ['agent', 'individual']
];

for (const [accountType, subtype] of CASES) {
  test(`${accountType}${subtype ? ` (${subtype})` : ''}: registration → documents → approval → profile → dashboard`, async () => {
    const role = cfg.roleFor(accountType);
    const { token, user } = await register(accountType, subtype);
    assert.deepEqual(user.roles, [role]);

    // Locked on the server before anything is submitted.
    const locked = await dashboard(token);
    assert.equal(locked.status, 403);
    assert.equal(locked.body.errors.code, 'ACCOUNT_GATE');
    assert.equal(await gateState(token), 'awaiting_documents');
    assert.equal((await call('POST', '/onboarding/submit', { token, body: { role } })).status, 422);

    await uploadMandatory(token, role, subtype);
    const submitted = await call('POST', '/onboarding/submit', { token, body: { role } });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.message, 'Your account has been submitted for verification. Please wait for admin approval.');
    assert.ok(adminAlerts.includes('New account verification request received.'));
    assert.equal(await gateState(token), 'pending_approval');
    assert.equal((await dashboard(token)).status, 403);

    // Admin queue, detail and decisions.
    const queue = await call('GET', `/admin/verifications?role=${role}`, { token: adminToken });
    const row = queue.body.data.rows.find((r) => r.email === user.email);
    assert.ok(row, 'request appears in the admin queue');
    assert.equal(row.status, 'pending_approval');
    const detail = (await call('GET', `/admin/verifications/${row._id}`, { token: adminToken })).body.data;
    assert.equal(detail.requirements.complete, true);
    assert.ok(detail.documents.every((d) => d.active));
    const preview = await call('GET', `/onboarding/documents/${detail.documents[0]._id}/file`, { token: adminToken });
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('cache-control'), /no-store/);

    assert.equal((await call('POST', `/admin/verifications/${row._id}/decision`, { token: adminToken, body: { action: 'under_review' } })).status, 200);
    assert.equal(await gateState(token), 'under_review');
    assert.equal((await call('POST', `/admin/verifications/${row._id}/decision`, { token: adminToken, body: { action: 'approve' } })).status, 200);
    assert.ok(notified.some((n) => n.userId === user._id && n.title === 'Your account has been approved.'));

    // Approved but the profile is still mandatory.
    assert.equal(await gateState(token), 'profile_incomplete');
    assert.equal((await dashboard(token)).status, 403);
    const fields = cfg.profileFields(role, subtype);
    const required = fields.filter((f) => f.required);
    const half = Object.fromEntries(required.slice(0, Math.ceil(required.length / 2)).map((f) => [f.key, validValue(f)]));
    const partial = await call('PUT', '/onboarding/profile', { token, body: { role, fields: half } });
    assert.equal(partial.status, 200);
    assert.ok(partial.body.data.percent > 0 && partial.body.data.percent < 100);
    assert.equal(partial.body.data.completed, false);
    const early = await call('PUT', '/onboarding/profile', { token, body: { role, fields: {}, complete: true } });
    assert.equal(early.status, 422);
    assert.ok(early.body.errors.missing.length > 0);

    const all = Object.fromEntries(fields.map((f) => [f.key, validValue(f)]));
    const done = await call('PUT', '/onboarding/profile', { token, body: { role, fields: all, complete: true } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.completed, true);
    assert.equal(done.body.data.percent, 100);
    assert.ok(notified.some((n) => n.userId === user._id && n.title === 'Your profile is complete.'));
    assert.equal(await gateState(token), 'ok');
    assert.equal((await dashboard(token)).status, 200);

    // Sensitive values are encrypted at rest and masked for the owner.
    const stored = await UserProfile.findOne({ user: user._id, role }).lean();
    for (const f of fields.filter((x) => x.sensitive)) {
      assert.ok(stored.sensitive[f.key].encrypted && !String(stored.sensitive[f.key].encrypted).includes('1234567'));
      const status = (await call('GET', '/onboarding/status', { token })).body.data.roles[0];
      assert.equal(status.profile.fields.find((x) => x.key === f.key).value, '••••');
    }

    // Removing a required field recalculates completion and locks the dashboard again.
    const removed = await call('PUT', '/onboarding/profile', { token, body: { role, fields: { [required[0].key]: '' } } });
    assert.equal(removed.body.data.completed, false);
    assert.equal(await gateState(token), 'profile_incomplete');
    assert.equal((await dashboard(token)).status, 403);

    const history = await VerificationHistory.find({ user: user._id }).sort({ createdAt: 1 }).lean();
    assert.deepEqual(history.map((h) => h.newStatus), ['awaiting_documents', 'pending_approval', 'under_review', 'approved']);
    assert.equal(await AdminAuditLog.countDocuments({ action: 'verification.approve' }), 1);
  });
}

test('rejection with a reason, resubmission of specific documents, then approval', async () => {
  const { token, user } = await register('teacher');
  await uploadMandatory(token, 'teacher');
  await call('POST', '/onboarding/submit', { token, body: { role: 'teacher' } });
  const id = (await RoleRequest.findOne({ user: user._id }))._id;

  assert.equal((await call('POST', `/admin/verifications/${id}/decision`, { token: adminToken, body: { action: 'reject' } })).status, 422, 'reason required');
  assert.equal((await call('POST', `/admin/verifications/${id}/decision`, { token: adminToken, body: { action: 'reject', reason: 'Degree is unreadable' } })).status, 200);
  const status = (await call('GET', '/onboarding/status', { token })).body.data;
  assert.equal(status.state, 'rejected');
  assert.equal(status.reason, 'Degree is unreadable');
  assert.ok(notified.some((n) => n.title === 'Your account verification was rejected.' && /Degree is unreadable/.test(n.body)));

  // Resubmit after rejection → admin asks for one document again.
  assert.equal((await call('POST', '/onboarding/submit', { token, body: { role: 'teacher' } })).status, 200);
  assert.equal((await call('POST', `/admin/verifications/${id}/decision`, { token: adminToken, body: { action: 'request_resubmission', reason: 'Blurry', documents: [] } })).status, 422);
  assert.equal((await call('POST', `/admin/verifications/${id}/decision`, { token: adminToken, body: { action: 'request_resubmission', reason: 'Blurry degree', documents: ['degree_certificate'] } })).status, 200);
  assert.equal(await gateState(token), 'resubmission_required');
  // The old rejected degree is still active, so submitting without replacing it fails.
  await VerificationDocument.updateMany({ user: user._id, documentType: { $ne: 'degree_certificate' } }, { verificationStatus: 'approved' });
  assert.equal((await call('POST', '/onboarding/submit', { token, body: { role: 'teacher' } })).status, 422);
  await call('POST', '/onboarding/documents?role=teacher&type=degree_certificate', { token, raw: pdf() });
  assert.equal((await call('POST', '/onboarding/submit', { token, body: { role: 'teacher' } })).status, 200);
  assert.equal(await VerificationDocument.countDocuments({ user: user._id, documentType: 'degree_certificate', active: false }), 1, 'replaced file kept for history');
  assert.equal((await call('POST', `/admin/verifications/${id}/decision`, { token: adminToken, body: { action: 'approve' } })).status, 200);
  assert.equal(await gateState(token), 'profile_incomplete');
});

test('documents are private: owner and verification admins only, file type and size are checked', async () => {
  const { token, user } = await register('student');
  const other = await register('parent');
  const up = await call('POST', '/onboarding/documents?role=student&type=b_form', { token, raw: pdf() });
  const id = up.body.data._id;
  assert.equal((await call('GET', `/onboarding/documents/${id}/file`)).status, 401);
  assert.equal((await call('GET', `/onboarding/documents/${id}/file`, { token: other.token })).status, 404);
  assert.equal((await call('GET', `/onboarding/documents/${id}/file`, { token })).status, 200);

  // Staff only with the verification department.
  const staff = await User.create({ fullName: 'Staff', email: 'staff@verify.test', passwordHash: 'x', roles: ['platform_staff'] });
  await StaffProfile.create({ user: staff._id, departments: ['finance'], addedBy: admin._id });
  assert.equal((await call('GET', `/onboarding/documents/${id}/file`, { token: tokenFor(staff) })).status, 404);
  assert.equal((await call('GET', '/admin/verifications', { token: tokenFor(staff) })).status, 403);
  await StaffProfile.updateOne({ user: staff._id }, { departments: ['verification'] });
  assert.equal((await call('GET', `/onboarding/documents/${id}/file`, { token: tokenFor(staff) })).status, 200);
  assert.equal((await call('GET', '/admin/verifications', { token: tokenFor(staff) })).status, 200);
  // A regular account can never reach the admin panel.
  assert.equal((await call('GET', '/admin/verifications', { token })).status, 403);

  assert.equal((await call('POST', '/onboarding/documents?role=student&type=cnic_front', { token, raw: Buffer.from('MZ fake exe') })).status, 422);
  assert.equal((await call('POST', '/onboarding/documents?role=student&type=profile_picture', { token, raw: pdf() })).status, 422, 'image only');
  assert.equal((await call('POST', '/onboarding/documents?role=student&type=degree_certificate', { token, raw: pdf() })).status, 422, 'not a student document');
  assert.equal((await call('POST', '/onboarding/documents?role=teacher&type=cnic_front', { token, raw: pdf() })).status, 403, 'not their account type');
  const big = Buffer.concat([png(), Buffer.alloc(6 * 1024 * 1024)]);
  assert.equal((await call('POST', '/onboarding/documents?role=student&type=cnic_front', { token, raw: big })).status, 413);
  // Same file reused as a different document is refused; re-sending the same one is a no-op.
  const same = pdf();
  assert.equal((await call('POST', '/onboarding/documents?role=student&type=cnic_front', { token, raw: same })).status, 201);
  assert.equal((await call('POST', '/onboarding/documents?role=student&type=cnic_front', { token, raw: same })).status, 200);
  assert.equal((await call('POST', '/onboarding/documents?role=student&type=cnic_back', { token, raw: same })).status, 409);
  assert.equal(await VerificationDocument.countDocuments({ user: user._id }), 2);
});

test('admins cannot approve their own account; suspend and reinstate', async () => {
  const { token, user } = await register('donor', 'individual');
  await uploadMandatory(token, 'donor', 'individual');
  await call('POST', '/onboarding/submit', { token, body: { role: 'donor' } });
  const request = await RoleRequest.findOne({ user: user._id });
  await User.updateOne({ _id: user._id }, { $push: { roles: 'admin' } });
  assert.equal((await call('POST', `/admin/verifications/${request._id}/decision`, { token, body: { action: 'approve' } })).status, 403);
  await User.updateOne({ _id: user._id }, { $pull: { roles: 'admin' } });

  await call('POST', `/admin/verifications/${request._id}/decision`, { token: adminToken, body: { action: 'approve' } });
  const fields = cfg.profileFields('donor', 'individual');
  await call('PUT', '/onboarding/profile', { token, body: { role: 'donor', fields: Object.fromEntries(fields.map((f) => [f.key, validValue(f)])), complete: true } });
  assert.equal((await dashboard(token)).status, 200);
  assert.equal((await call('POST', `/admin/verifications/${request._id}/decision`, { token: adminToken, body: { action: 'suspend', reason: 'Fraud report' } })).status, 200);
  assert.equal(await gateState(token), 'suspended');
  assert.equal((await dashboard(token)).status, 403);
  await call('POST', `/admin/verifications/${request._id}/decision`, { token: adminToken, body: { action: 'reinstate' } });
  assert.equal((await dashboard(token)).status, 200);
});

test('changing CNIC or replacing an identity document after approval requires re-verification', async () => {
  const { token, user } = await register('parent');
  await uploadMandatory(token, 'parent');
  await call('POST', '/onboarding/submit', { token, body: { role: 'parent' } });
  const request = await RoleRequest.findOne({ user: user._id });
  await call('POST', `/admin/verifications/${request._id}/decision`, { token: adminToken, body: { action: 'approve' } });
  const fields = cfg.profileFields('parent');
  await call('PUT', '/onboarding/profile', { token, body: { role: 'parent', fields: Object.fromEntries(fields.map((f) => [f.key, validValue(f)])), complete: true } });
  assert.equal((await dashboard(token)).status, 200);

  // The masked placeholder means "unchanged".
  assert.equal((await call('PUT', '/onboarding/profile', { token, body: { role: 'parent', fields: { cnicNumber: '••••', city: 'Lahore' } } })).body.data.reverification, false);
  const changed = await call('PUT', '/onboarding/profile', { token, body: { role: 'parent', fields: { cnicNumber: '35202-7654321-9' } } });
  assert.equal(changed.body.data.reverification, true);
  assert.equal(await gateState(token), 'pending_approval');
  assert.equal((await dashboard(token)).status, 403);
  await call('POST', `/admin/verifications/${request._id}/decision`, { token: adminToken, body: { action: 'approve' } });
  assert.equal((await dashboard(token)).status, 200, 'profile stays complete after re-approval');
  const detail = (await call('GET', `/admin/verifications/${request._id}`, { token: adminToken })).body.data;
  assert.equal(detail.profile.fields.find((f) => f.key === 'cnicNumber').value, '3520276543219', 'admins see the decrypted CNIC');

  await call('POST', '/onboarding/documents?role=parent&type=cnic_front', { token, raw: pdf() });
  assert.equal(await gateState(token), 'pending_approval');
  assert.ok(adminAlerts.some((t) => /Re-verification needed/.test(t)));
});

test('accounts created before mandatory verification are approved automatically but must complete the profile', async () => {
  const legacy = await User.create({ fullName: 'Old Teacher', email: 'old@verify.test', passwordHash: 'x', roles: ['student', 'teacher'], createdAt: new Date('2025-01-01') });
  const token = tokenFor(legacy);
  const status = (await call('GET', '/onboarding/status', { token })).body.data;
  assert.equal(status.state, 'profile_incomplete');
  assert.ok(status.roles.every((r) => r.status === 'approved'));
  assert.equal((await RoleRequest.find({ user: legacy._id, legacy: true })).length, 2);
  assert.equal((await dashboard(token)).status, 403);
  const fields = cfg.profileFields('student');
  await call('PUT', '/onboarding/profile', { token, body: { role: 'student', fields: Object.fromEntries(fields.map((f) => [f.key, validValue(f)])), complete: true } });
  const after = (await call('GET', '/onboarding/status', { token })).body.data;
  assert.equal(after.state, 'ok');
  assert.deepEqual(after.accessibleRoles, ['student'], 'teacher stays locked until its own profile is complete');
  assert.equal((await dashboard(token)).status, 200);
  // A new account created after the cut-off gets nothing automatically.
  const { VERIFICATION_REQUIRED_FROM } = require('../src/services/accountGate.service');
  const fresh = await User.create({ fullName: 'New', email: 'new@verify.test', passwordHash: 'x', roles: ['teacher'], createdAt: new Date(VERIFICATION_REQUIRED_FROM.getTime() + 60000) });
  assert.equal(await gateState(tokenFor(fresh)), 'awaiting_documents');
});

test('register rejects unknown account types and subtypes; requirements are public', async () => {
  assert.equal((await call('POST', '/auth/register', { body: { fullName: 'X', email: 'x@verify.test', password: 'Password123!', accountType: 'admin' } })).status, 422);
  assert.equal((await call('POST', '/auth/register', { body: { fullName: 'X', email: 'y@verify.test', password: 'Password123!', accountType: 'donor', subtype: 'bank' } })).status, 422);
  const req = await call('GET', '/onboarding/requirements');
  assert.equal(req.status, 200);
  assert.equal(req.body.data.accountTypes.length, 7);
});
