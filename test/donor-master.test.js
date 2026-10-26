const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Master donor rules over real HTTP: sponsorship payments go CareerZ fee first, then the student,
// checked by CareerZ; large donations state their source of funds; Super Admin sees donors and
// their activity; the donor's impact report and forecast work from the records (AI optional).
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => ({}));
mock.method(notifications, 'notifyAdmins', async () => {});
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);

let mongo, server, base;
const u = {};
async function account(name, role, subtype = '', fields = {}) {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@donor.test`, passwordHash: 'x', emailVerified: true, roles: [role], phone: '03001234567' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, subtype, completed: true, percent: 100, fields });
}
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${jwt.sign({ sub: String(u[who]._id) }, env.jwt.accessSecret, { expiresIn: '30m' })}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const is = (r, code, msg) => assert.equal(r.status, code, `${msg} → ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let seq = 0;
const leg = (amount) => ({ amount, transactionId: `DNR${Date.now()}${++seq}`, paidOn: new Date().toISOString(), file: { name: 'r.png', data: PNG } });
let sponsorship;

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Boss', 'super_admin');
  await account('Admin', 'admin');
  await account('Donor', 'donor', 'organization', { organizationName: 'Hope Trust', country: 'Pakistan', cnicNumber: '35202-1234567-1' });
  await account('Kid', 'student');
  await account('Other', 'student');
  await model('Setting').create({ key: 'platform_payment_account', value: { accountTitle: 'CareerZ', bankName: 'UBL', accountNumber: '0833272270819' } });
  const scholarship = await model('Scholarship').create({ title: 'Merit Award', description: 'For bright students', amount: 100000, currency: 'PKR', donor: u.Donor._id, seatsAvailable: 1, eligibilityCriteria: 'Good grades' });
  const application = await model('ScholarshipApplication').create({ scholarship: scholarship._id, applicant: u.Kid._id, statement: 'I need help with fees.', status: 'approved' });
  sponsorship = await model('Sponsorship').create({ donor: u.Donor._id, scholarship: scholarship._id, application: application._id, student: u.Kid._id, amount: 100000, currency: 'PKR', status: 'pending' });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('old one-receipt sponsorship and deposit flows are closed', async () => {
  is(await api('Donor', 'PATCH', `/scholarships/sponsorships/${sponsorship._id}/payment`, { amount: 100, paymentMethod: 'bank_transfer', reference: 'X1', proofUrl: 'https://x/y.jpg' }), 410, 'donor self-report');
  is(await api('Donor', 'POST', '/scholarships/donor/deposit', { amount: 1000, paymentMethod: 'bank_transfer', reference: 'D1', proofUrl: 'https://x/y.jpg' }), 410, 'deposit');
});

test('sponsorship payment: CareerZ scholarship fee first, then the student; instalments; large donations state their source', async () => {
  await model('Setting').create({ key: 'scholarship_commission_percent', value: 5 });
  is(await api('Donor', 'GET', `/manual-payments/quote/sponsorship_payment/${sponsorship._id}?amount=40000`), 409, 'the student has no account yet');
  await model('User').updateOne({ _id: u.Kid._id }, { $set: { payoutAccount: { method: 'mobile_wallet', bankName: 'JazzCash', accountTitle: 'Kid', accountNumber: '03001112233' } } });
  is(await api('Other', 'GET', `/manual-payments/quote/sponsorship_payment/${sponsorship._id}?amount=40000`), 404, 'only the donor');
  is(await api('Donor', 'GET', `/manual-payments/quote/sponsorship_payment/${sponsorship._id}?amount=200000`), 422, 'more than remains');
  is(await api('Boss', 'PUT', '/admin/donation-settings', { thresholdPkr: 30000 }), 200, 'large-donation rule');
  const q = (await api('Donor', 'GET', `/manual-payments/quote/sponsorship_payment/${sponsorship._id}?amount=40000`)).body.data;
  assert.deepEqual([q.commission, q.sellerAmount, q.sourceOfFundsRequired, q.seller.account], [2000, 40000, true, null]);
  const path = `/manual-payments/sponsorship_payment/${sponsorship._id}`;
  is(await api('Donor', 'POST', path, { amount: 40000, commission: leg(2000) }), 422, 'source of funds needed');
  const fee = await api('Donor', 'POST', path, { amount: 40000, commission: leg(2000), sourceOfFunds: 'Trust endowment income 2026' });
  is(fee, 201, 'fee step');
  is(await api('Admin', 'PATCH', `/manual-payments/${fee.body.data._id}/decide`, { decision: 'approve' }), 200, 'fee confirmed');
  is(await api('Donor', 'POST', path, { amount: 40000, seller: leg(40000) }), 201, 'paid the student');
  is(await api('Kid', 'PATCH', `/manual-payments/${fee.body.data._id}/confirm`, { received: true }), 200, 'student confirms');
  is(await api('Admin', 'PATCH', `/manual-payments/${fee.body.data._id}/decide`, { decision: 'approve' }), 200, 'approved');
  let s = await model('Sponsorship').findById(sponsorship._id);
  assert.deepEqual([s.paidAmount, s.status, s.paymentHistory.length], [40000, 'active', 1]);
  const rest = await api('Donor', 'POST', path, { amount: 60000, commission: leg(3000), sourceOfFunds: 'Trust endowment income 2026' });
  is(rest, 201, 'next instalment');
  await api('Admin', 'PATCH', `/manual-payments/${rest.body.data._id}/decide`, { decision: 'approve' });
  await api('Donor', 'POST', path, { amount: 60000, seller: leg(60000) });
  await api('Admin', 'PATCH', `/manual-payments/${rest.body.data._id}/decide`, { decision: 'approve' });
  s = await model('Sponsorship').findById(sponsorship._id);
  assert.deepEqual([s.paidAmount, s.status], [100000, 'completed']);
  is(await api('Donor', 'GET', `/manual-payments/quote/sponsorship_payment/${sponsorship._id}`), 409, 'nothing left to pay');
  assert.equal((await model('ManualPayment').findById(fee.body.data._id)).sourceOfFunds, 'Trust endowment income 2026');
});

test('Super Admin: donors list with organisation and country, activity, the large-donation setting', async () => {
  is(await api('Kid', 'GET', '/admin/donors'), 403, 'not staff');
  const row = (await api('Admin', 'GET', '/admin/donors')).body.data.find((d) => d._id === String(u.Donor._id));
  assert.deepEqual([row.organization, row.country, row.kind, row.verification, row.sponsorships, row.sponsoredPaid], ['Hope Trust', 'Pakistan', 'organization', 'approved', 1, 100000]);
  const act = (await api('Admin', 'GET', `/admin/donors/${u.Donor._id}/activity`)).body.data;
  assert.equal(act.sponsorships.length, 1);
  assert.equal(act.payments.length, 2);
  assert.equal(act.profile.cnicNumber, undefined, 'identity numbers are not shown');
  is(await api('Admin', 'PUT', '/admin/donation-settings', { thresholdPkr: 1 }), 403, 'only the Super Admin changes it');
  assert.equal((await api('Admin', 'GET', '/admin/donation-settings')).body.data.thresholdPkr, 30000);
});

test('donor impact report and forecast come from the records; AI needs the donor\'s key', async () => {
  const impact = (await api('Donor', 'GET', '/scholarships/mine/impact')).body.data.facts;
  assert.deepEqual([impact.studentsSponsored, impact.sponsorshipPaid, impact.completedSponsorships], [1, 100000, 1]);
  const f = (await api('Donor', 'GET', '/scholarships/mine/forecast')).body.data;
  assert.equal(f.history.length, 12);
  assert.equal(f.history[11].amountPkr, 100000, 'this month\'s giving');
  assert.equal(f.forecastPkr.length, 3);
  for (const p of ['/scholarships/mine/impact?ai=1', '/scholarships/mine/forecast?ai=1']) {
    const r = await api('Donor', 'GET', p);
    assert.ok(r.status >= 400 && r.status !== 500, `${p}: a clear error without a key`);
  }
  is(await api('Kid', 'GET', '/scholarships/mine/forecast'), 403, 'donors only');
});

test('scholarship application: donor lists required documents; the student fills the form, gives a reason and uploads each document', async () => {
  is(await api('Donor', 'POST', '/scholarships', { title: 'Need Award', amount: 50000, currency: 'PKR', seatsAvailable: 2, requiredDocuments: ['cnic', 'latest_result', 'not_a_doc'], otherDocuments: ['Hafiz-e-Quran certificate'] }), 201, 'post');
  const sch = await model('Scholarship').findOne({ title: 'Need Award' });
  assert.deepEqual(sch.requiredDocuments, ['cnic', 'latest_result'], 'unknown document keys are dropped');
  const formInfo = (await api('Other', 'GET', `/scholarships/${sch._id}/apply-form`)).body.data;
  assert.deepEqual(formInfo.documents.map((d) => d.key), ['cnic', 'latest_result', 'other_0']);
  assert.ok(formInfo.fields.find((f) => f.key === 'fatherName').required);
  const body = require('./helpers/scholarshipForm')();
  is(await api('Other', 'POST', `/scholarships/${sch._id}/apply`, { ...body, form: { ...body.form, fatherName: '' } }), 422, 'form incomplete');
  is(await api('Other', 'POST', `/scholarships/${sch._id}/apply`, { ...body, reason: 'Too short' }), 422, 'reason too short');
  is(await api('Other', 'POST', `/scholarships/${sch._id}/apply`, body), 422, 'documents missing');
  is(await api('Other', 'POST', `/scholarships/${sch._id}/documents`, { key: 'passport', file: { name: 'p.png', data: PNG } }), 422, 'not requested');
  const docs = [];
  for (const key of ['cnic', 'latest_result', 'other_0']) {
    const up = await api('Other', 'POST', `/scholarships/${sch._id}/documents`, { key, file: { name: `${key}.png`, data: PNG } });
    is(up, 201, `upload ${key}`);
    docs.push({ key, fileId: up.body.data.fileId });
  }
  const theirs = await api('Kid', 'POST', `/scholarships/${sch._id}/documents`, { key: 'cnic', file: { name: 'k.png', data: PNG } });
  is(await api('Other', 'POST', `/scholarships/${sch._id}/apply`, { ...body, documents: [{ key: 'cnic', fileId: theirs.body.data.fileId }, ...docs.slice(1)] }), 422, 'someone else\'s file');
  const applied = await api('Other', 'POST', `/scholarships/${sch._id}/apply`, { ...body, documents: docs });
  is(applied, 201, 'applied');
  const list = (await api('Donor', 'GET', `/scholarships/${sch._id}/applicants`)).body.data;
  assert.equal(list[0].form.fatherName, 'Test Father');
  assert.equal(list[0].documents.length, 3);
  const fileId = list[0].documents[0].file;
  const get = (who) => fetch(`${base}/scholarships/applications/${applied.body.data._id}/documents/${fileId}`, { headers: { Authorization: `Bearer ${jwt.sign({ sub: String(u[who]._id) }, env.jwt.accessSecret, { expiresIn: '5m' })}` } });
  assert.equal((await get('Donor')).status, 200, 'donor opens it');
  assert.equal((await get('Other')).status, 200, 'applicant opens it');
  assert.equal((await get('Kid')).status, 404, 'nobody else');
});

test('funding request: the student asks with documents; CareerZ verifies; donors then see it and its documents', async () => {
  const base_ = { requestType: 'student', category: 'scholarship', title: 'Semester 5 fee', purpose: 'I need help with my semester 5 tuition fee at GCUF because my father lost his job this year.', requiredAmount: 80000, currency: 'PKR' };
  is(await api('Other', 'POST', '/funding-requests', { ...base_, requestType: 'institution' }), 403, 'a student cannot ask for an institute');
  is(await api('Other', 'POST', '/funding-requests', { ...base_, purpose: 'Need money' }), 422, 'purpose too short');
  is(await api('Other', 'POST', '/funding-requests', base_), 422, 'a document is required');
  const up = await api('Other', 'POST', '/funding-requests/documents', { file: { name: 'voucher.png', data: PNG } });
  is(up, 201, 'upload');
  const made = await api('Other', 'POST', '/funding-requests', { ...base_, documents: [{ name: 'Fee voucher', fileId: up.body.data.fileId }] });
  is(made, 201, 'request');
  const id = made.body.data._id;
  is(await api('Kid', 'GET', '/funding-requests/admin/review'), 403, 'not staff');
  assert.ok((await api('Admin', 'GET', '/funding-requests/admin/review')).body.data.some((r) => r._id === id), 'in the review queue');
  const fileId = made.body.data.documents[0].file;
  const open = (who) => fetch(`${base}/funding-requests/${id}/documents/${fileId}`, { headers: { Authorization: `Bearer ${jwt.sign({ sub: String(u[who]._id) }, env.jwt.accessSecret, { expiresIn: '5m' })}` } });
  assert.equal((await open('Donor')).status, 404, 'donors cannot open it before verification');
  assert.equal((await open('Admin')).status, 200, 'CareerZ staff can');
  is(await api('Admin', 'PATCH', `/funding-requests/${id}/verify`, { verificationStatus: 'rejected' }), 422, 'rejection needs a reason');
  is(await api('Admin', 'PATCH', `/funding-requests/${id}/verify`, { verificationStatus: 'verified' }), 200, 'verify');
  assert.equal((await open('Donor')).status, 200, 'donors can open it now');
  assert.equal((await open('Kid')).status, 404, 'another student cannot');
});
