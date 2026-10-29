const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Super Admin Comments & Ratings Management: every rating in one place, hide / show / edit / delete,
// hidden ratings leave public lists and averages, institute-wise and monthly reports.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
mock.method(emailService, 'sendEmail', async () => ({ ok: true }));
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base, school;
const u = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tok(u[who])}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role) {
  u[name] = await model('User').create({ fullName: `${name} Khan`, email: `${name.toLowerCase()}@cr.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', country: 'PK', city: 'Lahore' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}

const S = {};
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Boss', 'super_admin');
  await account('Owner', 'institution');
  await account('Mum', 'parent');
  await account('Buyer', 'student');
  await account('Seller', 'student');
  await account('Teach', 'teacher');
  await account('Emp', 'employer');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  school = await model('Institution').create({ name: 'Rated School', slug: 'rated-school', type: 'school', country: 'PK', city: 'Lahore', owner: u.Owner._id, verificationStatus: 'approved', status: 'active' });
  const oid = () => new mongoose.Types.ObjectId();
  S.product = await model('Product').create({ seller: u.Seller._id, title: 'Physics notes', description: 'Notes', price: 500, currency: 'PKR', stock: 3, category: 'notes', status: 'active' }).catch(() => ({ _id: oid() }));
  S.rev1 = await model('Review').create({ order: oid(), product: S.product._id, seller: u.Seller._id, buyer: u.Buyer._id, rating: 1, comment: 'Total scam you idiot', reported: true, reportReason: 'Abusive' });
  S.rev2 = await model('Review').create({ order: oid(), product: S.product._id, seller: u.Seller._id, buyer: u.Mum._id, rating: 5, comment: 'Great notes' });
  S.inst = await model('InstitutionFeedback').create({ institution: school._id, fromUser: u.Mum._id, rating: 2, comment: 'Fees too high' });
  await model('InstitutionFeedback').create({ institution: school._id, fromUser: u.Buyer._id, rating: 4, comment: 'Good teachers' });
  S.teach = await model('TeacherFeedback').create({ teacher: u.Teach._id, fromUser: u.Mum._id, fromRole: 'parent', institution: school._id, rating: 5, comment: 'Very kind' });
  S.company = await model('CompanyReview').create({ employer: u.Emp._id, reviewer: u.Buyer._id, employment: oid(), rating: 3, comment: 'Salary was late twice.', status: 'published', report: { reason: 'Fake', at: new Date(), open: true } });
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('every rating in one list, filtered; only admins', async () => {
  expect(await api('Owner', 'GET', '/admin/comments-ratings'), 403);
  const all = (await api('Boss', 'GET', '/admin/comments-ratings')).body.data;
  assert.equal(all.length, 6);
  assert.deepEqual([...new Set(all.map((r) => r.source))].sort(), ['company', 'institution', 'product', 'teacher']);
  const reported = (await api('Boss', 'GET', '/admin/comments-ratings?status=reported')).body.data;
  assert.equal(reported.length, 2, 'reported product review and company review');
  assert.equal((await api('Boss', 'GET', '/admin/comments-ratings?source=institution')).body.data.length, 2);
  assert.equal((await api('Boss', 'GET', `/admin/comments-ratings?institution=${school._id}`)).body.data.length, 3, 'institute + its teacher ratings');
  assert.equal((await api('Boss', 'GET', '/admin/comments-ratings?q=scam')).body.data[0].text, 'Total scam you idiot');
  expect(await api('Boss', 'GET', '/admin/comments-ratings?source=nope'), 404);
});

test('hide (with a reason) leaves public lists and averages; show brings it back', async () => {
  const path = `/admin/comments-ratings/product/${S.rev1._id}`;
  expect(await api('Boss', 'PATCH', path, { action: 'hide' }), 422, 'needs a reason');
  const r = await api('Boss', 'PATCH', path, { action: 'hide', note: 'Abusive words' });
  expect(r, 200);
  assert.equal(r.body.data.hidden, true);
  assert.equal(r.body.data.reported, false, 'report closed');
  const pub = (await api(null, 'GET', `/marketplace/products/${S.product._id}/reviews`)).body.data;
  const list = Array.isArray(pub) ? pub : pub.reviews || pub.items || [];
  assert.ok(!JSON.stringify(list).includes('scam'), 'hidden review not public');
  assert.ok((await model('Notification').countDocuments({ user: u.Buyer._id })) >= 1, 'author told');
  expect(await api('Boss', 'PATCH', `/admin/comments-ratings/company/${S.company._id}`, { action: 'hide', note: 'Fake review' }), 200);
  assert.equal((await model('CompanyReview').findById(S.company._id)).status, 'hidden');
  expect(await api('Boss', 'PATCH', `/admin/comments-ratings/company/${S.company._id}`, { action: 'show' }), 200);
  assert.equal((await model('CompanyReview').findById(S.company._id)).status, 'published');
});

test('edit text and delete (with a reason)', async () => {
  const e = await api('Boss', 'PATCH', `/admin/comments-ratings/teacher/${S.teach._id}`, { action: 'edit', text: 'Very kind teacher', note: 'Typo' });
  expect(e, 200);
  assert.equal(e.body.data.text, 'Very kind teacher');
  assert.equal(e.body.data.moderation.edited, true);
  expect(await api('Boss', 'PATCH', `/admin/comments-ratings/institution/${S.inst._id}`, { action: 'delete' }), 422);
  expect(await api('Boss', 'PATCH', `/admin/comments-ratings/institution/${S.inst._id}`, { action: 'delete', note: 'Duplicate account' }), 200);
  assert.equal(await model('InstitutionFeedback').countDocuments(), 1);
  expect(await api('Boss', 'PATCH', `/admin/comments-ratings/institution/${S.inst._id}`, { action: 'hide', note: 'x' }), 404);
});

test('report: totals, star counts, institute-wise averages, monthly graph', async () => {
  const r = (await api('Boss', 'GET', '/admin/comments-ratings/report?months=6')).body.data;
  assert.equal(r.totals.product.count, 2);
  assert.equal(r.totals.product.hidden, 1);
  assert.equal(r.totals.product.stars[5], 1, 'hidden 1-star not counted');
  assert.equal(r.totals.institution.average, 4);
  const s = r.institutions.find((i) => i.name === 'Rated School');
  assert.equal(s.instituteAverage, 4);
  assert.equal(s.teacherAverage, 5);
  assert.equal(r.timeline.length, 6);
  assert.equal(r.timeline.at(-1).product.count, 2);
});
