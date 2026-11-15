const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'audit-test';
const shell = path.join(os.tmpdir(), `audit-shell-${process.pid}.html`);
fs.writeFileSync(shell, '<html lang="en"><head><!--seo:head--><title>x</title><!--/seo:head--></head><body><div id="root"><!--seo:body--><!--/seo:body--></div></body></html>');
process.env.SEO_TEMPLATE_PATH = shell;
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyAdmins', async () => {});
const app = require('../src/app');
const m = (n) => require('../src/models/' + n);
const User = m('User'), Wallet = m('Wallet'), WalletTransaction = m('WalletTransaction'), RoleRequest = m('RoleRequest'), UserProfile = m('UserProfile'), VerificationCode = m('VerificationCode');
const otp = require('../src/services/otp.service');

let mongo, server, base, sender, receiver, S;
const call = async (method, p, body, auth) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + auth } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) };
};
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await WalletTransaction.syncIndexes();
  const passwordHash = await User.hashPassword('Good@Pass123');
  const make = async (fullName, email) => {
    const u = await User.create({ fullName, email, passwordHash, emailVerified: true, roles: ['student'], status: 'active', city: 'Lahore', country: 'PK', phone: '03001234567' });
    await RoleRequest.create({ user: u._id, requestedRole: 'student', status: 'approved', approvedAt: new Date(Date.now() - 864e5 * 30) });
    await UserProfile.updateOne({ user: u._id, role: 'student' }, { $set: { completed: true, percent: 100 } }, { upsert: true });
    return u;
  };
  sender = await make('Sender', 'sender@audit.test');
  receiver = await make('Receiver', 'receiver@audit.test');
  await Wallet.create([{ user: sender._id, currency: 'PKR', available: 1000, pending: 0 }, { user: receiver._id, currency: 'PKR', available: 376, pending: 0 }]);
  S = jwt.sign({ sub: String(sender._id) }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
  server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port + '/api';
});
after(async () => { server.close(); await mongoose.disconnect(); await mongo.stop(); fs.rmSync(shell, { force: true }); });

test('BUG-013: one code is accepted once even when two checks arrive together', async () => {
  await VerificationCode.create({ user: sender._id, purpose: 'password_reset', codeHash: await bcrypt.hash('123456', 4), expiresAt: new Date(Date.now() + 6e5), consumed: false });
  const results = await Promise.all([otp.verifyOtp(sender, 'password_reset', '123456'), otp.verifyOtp(sender, 'password_reset', '123456'), otp.verifyOtp(sender, 'password_reset', '123456')]);
  assert.equal(results.filter(Boolean).length, 1);
});

test('BUG-014: the transfer reply carries only the sender balance', async () => {
  const r = await call('POST', '/wallet/transfer', { recipientEmail: 'receiver@audit.test', amount: 1, currency: 'PKR' }, S);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.recipientAvailable, undefined);
  assert.equal(r.body.data.senderAvailable, 999);
});

test('BUG-015: the same transfer sent twice, or twice at once, moves money once', async () => {
  const body = { recipientEmail: 'receiver@audit.test', amount: 10, currency: 'PKR', requestId: 'transfer-key-0001' };
  const first = await call('POST', '/wallet/transfer', body, S);
  const again = await call('POST', '/wallet/transfer', body, S);
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(again.body.data.reference, first.body.data.reference);
  const together = await Promise.all([1, 2, 3].map(() => call('POST', '/wallet/transfer', { ...body, requestId: 'transfer-key-0002' }, S)));
  assert.ok(together.every((r) => r.status === 200), together.map((r) => r.status + ' ' + r.body.message).join(' | '));
  assert.equal(await WalletTransaction.countDocuments({ user: sender._id, type: 'transfer_out', requestKey: 'transfer-key-0002' }), 1);
  assert.equal((await Wallet.findOne({ user: sender._id, currency: 'PKR' })).available, 979);
  assert.equal((await call('POST', '/wallet/transfer', { ...body, requestId: 'bad key!' }, S)).status, 422);
});

test('BUG-015: a repeated withdrawal request reserves the money once', async () => {
  const body = { amount: 50, currency: 'PKR', method: 'mobile_wallet', provider: 'JazzCash', accountNumber: '03001234567', accountTitle: 'Sender Person', requestId: 'withdraw-key-0001' };
  const a = await call('POST', '/wallet/withdraw', body, S);
  const b = await call('POST', '/wallet/withdraw', body, S);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.body.data.reference, a.body.data.reference);
  const w = await Wallet.findOne({ user: sender._id, currency: 'PKR' });
  assert.equal(w.pending, 50);
});

test('BUG-016: escrow totals are kept apart by currency', async () => {
  const Order = m('Order');
  await Order.collection.insertMany([
    { buyer: sender._id, seller: receiver._id, totalPrice: 100, currency: 'PKR', escrow: { status: 'held' }, createdAt: new Date() },
    { buyer: sender._id, seller: receiver._id, totalPrice: 100, currency: 'USD', escrow: { status: 'held' }, createdAt: new Date() }
  ]);
  const { totals, counts } = await require('../src/services/marketplaceEscrow.service').adminEscrow();
  assert.deepEqual(totals.held, { PKR: 100, USD: 100 });
  assert.equal(counts.held, 2);
});

test('BUG-017: a backup copy reads the hidden fields too', async () => {
  await User.updateOne({ _id: receiver._id }, { $set: { payoutAccount: { method: 'mobile_wallet', bankName: 'JazzCash', accountTitle: 'Receiver', accountNumber: '03001234567' } } });
  const viaModel = await User.findById(receiver._id).lean();
  const viaCollection = await User.collection.findOne({ _id: receiver._id });
  assert.equal(viaModel.payoutAccount, undefined, 'normal reads hide it');
  assert.equal(viaCollection.payoutAccount.accountNumber, '03001234567', 'the backup reads it');
  const src = fs.readFileSync(path.join(__dirname, '../src/controllers/backup.controller.js'), 'utf8');
  assert.ok(!src.includes('Model.find().lean()') && !src.includes('Model.findById(ref.id).lean()'));
});

test('BUG-012: production refuses to start without its secrets', () => {
  const run = (extra) => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '../src/config/env'))})`], { cwd: os.tmpdir(), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DOTENV_CONFIG_PATH: 'none.env', ...extra }, encoding: 'utf8' });
  const bare = run({ NODE_ENV: 'production' });
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /JWT_ACCESS_SECRET/);
  assert.equal(run({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'b' }).status, 0);
});

test('BUG-022: links use the first site address only', () => {
  const r = spawnSync(process.execPath, ['-e', `const e=require(${JSON.stringify(path.join(__dirname, '../src/config/env'))});console.log(JSON.stringify([e.clientUrl,e.clientOrigins]))`], { cwd: os.tmpdir(), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DOTENV_CONFIG_PATH: 'none.env', NODE_ENV: 'test', CLIENT_URL: 'https://careerz.pk, https://www.careerz.pk/,https://internal.example' }, encoding: 'utf8' });
  const [url, list] = JSON.parse(r.stdout.trim());
  assert.equal(url, 'https://careerz.pk');
  assert.deepEqual(list, ['https://careerz.pk', 'https://www.careerz.pk', 'https://internal.example']);
});

test('N-03: the search-engine page has no API security header that blocks images and analytics', async () => {
  const r = await fetch(base + '/seo/render?path=/');
  assert.equal(r.headers.get('content-security-policy'), null);
  const api = await fetch(base + '/health');
  assert.ok(api.headers.get('content-security-policy'), 'the API keeps its header');
});

test('N-08: a new employer with no hiring activity gets no score yet', async () => {
  const employer = await User.create({ fullName: 'New Employer', email: 'newemp@audit.test', passwordHash: 'x', roles: ['employer'], status: 'active' });
  const t = await require('../src/services/employerTrust.service').trustScore(employer._id);
  assert.equal(t.score, null);
  assert.equal(t.level, 'New');
  assert.equal(t.insufficientData, true);
});

test('BUG-018: an attempt ends at the exam closing time, and a submit after closing is refused', async () => {
  const Course = m('Course'), Exam = m('Exam'), Enrollment = m('Enrollment'), ExamSubmission = m('ExamSubmission');
  const teacher = await User.create({ fullName: 'Exam Teacher', email: 'examteacher@audit.test', passwordHash: 'x', roles: ['teacher'], status: 'active' });
  const course = await Course.create({ title: 'Exam course', teacher: teacher._id, published: true, price: 0, currency: 'PKR', isFree: true });
  await Enrollment.create({ student: sender._id, course: course._id });
  const closesAt = new Date(Date.now() + 10 * 60000);
  const exam = await Exam.create({ course: course._id, teacher: teacher._id, title: 'Quiz', published: true, durationMinutes: 60, closesAt, questions: [{ text: '1 + 1?', type: 'mcq', options: ['1', '2'], correctAnswer: 1, marks: 1 }] });
  const start = await call('POST', '/courses/exams/' + exam._id + '/start', {}, S);
  assert.equal(start.status, 200, start.body.message);
  assert.equal(new Date(start.body.data.attempt.expiresAt).getTime(), closesAt.getTime(), 'a 60 minute exam that closes in 10 minutes ends in 10');
  await Exam.updateOne({ _id: exam._id }, { $set: { closesAt: new Date(Date.now() - 3 * 60000) } });
  await ExamSubmission.updateOne({ exam: exam._id, student: sender._id }, { $set: { expiresAt: new Date(Date.now() + 30 * 60000) } });
  const late = await call('POST', '/courses/exams/' + exam._id + '/submit', { answers: [1] }, S);
  assert.equal(late.status, 409);
  assert.match(late.body.message, /closed/);
});
