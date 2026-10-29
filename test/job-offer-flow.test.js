const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Offer (salary, joining date, reply-by, terms) → candidate accepts or declines → offer letter →
// Joined makes the employment active; and the message thread on an application.
process.env.NODE_ENV = 'test';
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
const emails = [];
mock.method(emailService, 'sendEmail', async (m) => { emails.push(m); return { ok: true }; });
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base;
const u = {}, S = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${tok(u[who])}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* file */ }
  return { status: res.status, body: json, text, type: res.headers.get('content-type') };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role, subtype = '') {
  u[name] = await model('User').create({ fullName: name, email: `${name.toLowerCase()}@offer.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', city: 'Lahore', country: 'PK' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved', subtype, approvedAt: new Date(Date.now() - 30 * 864e5) });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const job = (title) => ({ title, company: 'Bright School', country: 'PK', city: 'Lahore', category: 'teaching', type: 'full_time', salaryMin: 60000, currency: 'PKR', description: 'Teach physics to secondary classes at our Lahore campus. B.Sc and B.Ed required.' });
const letter = 'Dear Candidate,\nWe are pleased to confirm your appointment as Physics Teacher at a monthly salary of PKR 85,000, starting 1 December 2026.';

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Employer', 'employer', 'company');
  await account('Other', 'employer', 'company');
  await account('Cand', 'student');
  await account('Cand2', 'student');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  S.job = (await api('Employer', 'POST', '/jobs', job('Physics Teacher'))).body.data._id;
  S.app = (await api('Cand', 'POST', `/jobs/${S.job}/apply`, {})).body.data._id;
  S.app2 = (await api('Cand2', 'POST', `/jobs/${S.job}/apply`, {})).body.data._id;
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); });

test('the employer makes an offer with salary; the candidate sees it and is emailed', async () => {
  expect(await api('Employer', 'POST', `/jobs/applications/${S.app}/offer`, {}), 422, 'salary required');
  expect(await api('Employer', 'POST', `/jobs/applications/${S.app}/offer`, { salary: 80000, expiresAt: '2020-01-01' }), 422, 'reply-by in the past');
  expect(await api('Other', 'POST', `/jobs/applications/${S.app}/offer`, { salary: 80000 }), 403);
  expect(await api('Employer', 'POST', `/jobs/applications/${S.app}/offer-letter`, { text: letter }), 409, 'no letter before an offer');
  emails.length = 0;
  expect(await api('Employer', 'POST', `/jobs/applications/${S.app}/offer`, { salary: 80000, currency: 'PKR', startDate: '2026-12-01', expiresAt: '2027-01-15', terms: 'Probation 3 months.' }), 200);
  expect(await api('Employer', 'POST', `/jobs/applications/${S.app}/offer`, { salary: 85000, currency: 'PKR', startDate: '2026-12-01', expiresAt: '2027-01-15', terms: 'Probation 3 months.' }), 200, 'revised offer');
  expect(await api('Employer', 'POST', `/jobs/applications/${S.app}/offer-letter`, { text: letter }), 200, 'the letter goes together with the offer');
  assert.ok(emails.some((m) => m.to === 'cand@offer.test' && /Revised job offer/.test(m.subject)));
  const [mine] = (await api('Cand', 'GET', '/employment/mine')).body.data;
  assert.equal(mine.salary, 85000);
  assert.equal(mine.status, 'offered');
  assert.equal(mine.offer.terms, 'Probation 3 months.');
  const list = (await api('Employer', 'GET', `/jobs/${S.job}/applicants`)).body.data;
  assert.equal(list.find((a) => a._id === S.app).employment.salary, 85000);
  assert.equal(list.find((a) => a._id === S.app).status, 'selected');
});

test('accept → Offer accepted; offer letter (text and PDF); Joined makes the employment active', async () => {
  const id = (await api('Cand', 'GET', '/employment/mine')).body.data[0]._id;
  expect(await api('Cand2', 'PATCH', `/employment/${id}/respond`, { decision: 'accepted', signedName: 'Signed Candidate' }), 403);
  expect(await api('Cand', 'PATCH', `/employment/${id}/respond`, { decision: 'accepted', signedName: 'Signed Candidate' }), 200);
  assert.equal((await model('JobApplication').findById(S.app)).status, 'accepted');
  assert.equal((await model('Employment').findById(id)).status, 'accepted', 'not active before joining');
  expect(await api('Employer', 'POST', `/jobs/applications/${S.app}/offer`, { salary: 90000 }), 409, 'no new offer after acceptance');
  expect(await api('Employer', 'POST', `/jobs/applications/${S.app}/offer-letter`, { text: 'short' }), 422);
  const pdf = { name: 'Offer.pdf', data: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 signed offer').toString('base64') };
  expect(await api('Employer', 'POST', `/jobs/applications/${S.app}/offer-letter`, { text: letter, file: pdf }), 200);
  const emp = (await api('Cand', 'GET', '/employment/mine')).body.data[0];
  assert.match(emp.offerLetter.text, /pleased to confirm/);
  const file = await api('Cand', 'GET', `/jobs/offer-letters/${id}/file`);
  expect(file, 200);
  assert.match(file.text, /signed offer/);
  expect(await api('Cand2', 'GET', `/jobs/offer-letters/${id}/file`), 403);
  expect(await api('Employer', 'PATCH', `/jobs/applications/${S.app}/status`, { status: 'hired' }), 200);
  assert.equal((await model('Employment').findById(id)).status, 'active');
  assert.equal(await model('Employment').countDocuments({ application: S.app }), 1, 'no duplicate employment');
});

test('decline → application withdrawn; expired offers cannot be accepted', async () => {
  await api('Employer', 'POST', `/jobs/applications/${S.app2}/offer`, { salary: 70000, expiresAt: '2027-01-01' });
  const emp = await model('Employment').findOne({ application: S.app2 });
  await model('Employment').updateOne({ _id: emp._id }, { $set: { 'offer.expiresAt': new Date(Date.now() - 1000) } });
  expect(await api('Cand2', 'PATCH', `/employment/${emp._id}/respond`, { decision: 'accepted', signedName: 'Signed Candidate' }), 409, 'expired');
  await model('Employment').updateOne({ _id: emp._id }, { $set: { 'offer.expiresAt': null } });
  expect(await api('Cand2', 'PATCH', `/employment/${emp._id}/respond`, { decision: 'declined' }), 200);
  assert.equal((await model('JobApplication').findById(S.app2)).status, 'withdrawn');
  assert.ok(await model('Notification').findOne({ user: u.Employer._id, title: /Offer declined/ }));
});

test('message thread: both sides talk, outsiders cannot', async () => {
  expect(await api('Cand', 'POST', `/jobs/applications/${S.app}/messages`, { text: 'Thank you! What should I bring on day one?' }), 200);
  expect(await api('Employer', 'POST', `/jobs/applications/${S.app}/messages`, { text: 'Your CNIC and degree copies.' }), 200);
  expect(await api('Other', 'GET', `/jobs/applications/${S.app}/messages`), 403);
  expect(await api('Cand2', 'POST', `/jobs/applications/${S.app}/messages`, { text: 'hi' }), 403);
  expect(await api('Cand', 'POST', `/jobs/applications/${S.app}/messages`, { text: '  ' }), 422);
  const t = (await api('Cand', 'GET', `/jobs/applications/${S.app}/messages`)).body.data;
  assert.equal(t.side, 'candidate');
  assert.deepEqual(t.messages.map((m) => m.side), ['candidate', 'employer']);
  assert.ok(await model('Notification').findOne({ user: u.Employer._id, title: /Message from Cand/ }));
  assert.ok(await model('Notification').findOne({ user: u.Cand._id, title: /Message from Bright School/ }));
  const mine = (await api('Cand', 'GET', '/jobs/mine/applications')).body.data.find((a) => a._id === S.app);
  assert.equal(mine.messageCount, 2);
});

test('interview rounds are scheduled with a date; "not selected" withdraws the offer and cancels interviews; completed closes employment', async () => {
  await account('Cand3', 'student');
  const job3 = (await api('Employer', 'POST', '/jobs', job('Chemistry Teacher'))).body.data._id;
  const app3 = (await api('Cand3', 'POST', `/jobs/${job3}/apply`, {})).body.data._id;
  const soon = new Date(Date.now() + 3 * 864e5).toISOString();
  expect(await api('Employer', 'POST', `/jobs/applications/${app3}/schedule-interview`, { scheduledDate: '2020-01-01T10:00' }), 422, 'past date');
  expect(await api('Employer', 'POST', `/jobs/applications/${app3}/schedule-interview`, { scheduledDate: soon, mode: 'physical' }), 422, 'address needed');
  expect(await api('Employer', 'POST', `/jobs/applications/${app3}/schedule-interview`, { scheduledDate: soon, mode: 'online', meetingLink: 'https://meet.example/abc' }), 201);
  assert.equal((await model('JobApplication').findById(app3)).status, 'interview');
  expect(await api('Employer', 'POST', `/jobs/applications/${app3}/schedule-interview`, { scheduledDate: soon, mode: 'physical', location: 'Main campus, Room 4', round: 'final_interview' }), 201);
  const a3 = await model('JobApplication').findById(app3);
  assert.equal(a3.status, 'final_interview');
  assert.ok(a3.statusHistory.some((h) => h.status === 'final_interview'));
  assert.equal((await model('Interview').findOne({ application: app3, round: 'final_interview' })).location, 'Main campus, Room 4');
  await api('Employer', 'POST', `/jobs/applications/${app3}/offer`, { salary: 75000 });
  expect(await api('Employer', 'PATCH', `/jobs/applications/${app3}/status`, { status: 'rejected', note: 'Position filled internally' }), 200);
  assert.equal((await model('Employment').findOne({ application: app3 })).status, 'withdrawn');
  assert.equal(await model('Interview').countDocuments({ application: app3, status: 'scheduled' }), 0, 'upcoming interviews cancelled');
  // The first candidate joined earlier: completing closes the employment.
  await model('JobApplication').updateOne({ _id: S.app }, { $set: { 'joining.confirmed': true } });
  expect(await api('Employer', 'PATCH', `/jobs/applications/${S.app}/status`, { status: 'completed', note: 'Contract finished' }), 200);
  const emp = await model('Employment').findOne({ application: S.app });
  assert.equal(emp.status, 'completed');
  assert.equal(emp.endReason, 'Contract finished');
});

test('online interviews open in CareerZ\'s own video room: only the candidate and the hiring side, only near the time', async () => {
  await account('Cand4', 'student');
  const job4 = (await api('Employer', 'POST', '/jobs', job('Biology Teacher'))).body.data._id;
  const app4 = (await api('Cand4', 'POST', `/jobs/${job4}/apply`, {})).body.data._id;
  const later = await api('Employer', 'POST', `/jobs/applications/${app4}/schedule-interview`, { scheduledDate: new Date(Date.now() + 2 * 864e5).toISOString(), mode: 'online', meetingLink: 'https://zoom.example/should-be-ignored' });
  expect(later, 201);
  assert.match(later.body.data.meetingLink, /\/dashboard\?interview=/, 'built-in room link, outside links ignored');
  expect(await api('Cand4', 'GET', `/jobs/interviews/${later.body.data._id}/video`), 409, 'room not open yet');
  const now = await api('Employer', 'POST', `/jobs/applications/${app4}/schedule-interview`, { scheduledDate: new Date(Date.now() + 5 * 60000).toISOString(), mode: 'online' });
  const id = now.body.data._id;
  const cand = await api('Cand4', 'GET', `/jobs/interviews/${id}/video`);
  expect(cand, 200);
  assert.equal(cand.body.data.host, false);
  assert.ok(cand.body.data.iceServers.length >= 1);
  assert.equal((await api('Employer', 'GET', `/jobs/interviews/${id}/video`)).body.data.host, true);
  expect(await api('Other', 'GET', `/jobs/interviews/${id}/video`), 403);
  expect(await api('Cand', 'GET', `/jobs/interviews/${id}/video`), 403);
  const { access } = require('../src/realtime/privateRooms');
  assert.equal((await access(`interview:${id}`, String(u.Cand4._id))).role, 'student');
  assert.equal((await access(`interview:${id}`, String(u.Employer._id))).role, 'teacher');
  await assert.rejects(access(`interview:${id}`, String(u.Other._id)));
});
