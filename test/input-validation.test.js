const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'input-test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyAdmins', async () => {});
const app = require('../src/app');
const User = require('../src/models/User');
const Wallet = require('../src/models/Wallet');
const RoleRequest = require('../src/models/RoleRequest');
const UserProfile = require('../src/models/UserProfile');

const PASSWORD = 'Good@Pass123';
let mongo, server, base, token, user, other;
const call = async (method, path, body, auth) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + auth } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const balance = async () => (await Wallet.findOne({ user: user._id, currency: 'PKR' }).lean()).available;
const ne = { $ne: null };

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  const passwordHash = await User.hashPassword(PASSWORD);
  const make = (fullName, email) => User.create({ fullName, email, passwordHash, emailVerified: true, roles: ['student'], status: 'active', city: 'Lahore', country: 'PK', phone: '03001234567' });
  user = await make('Sender Person', 'sender@input.test');
  other = await make('Receiver Person', 'receiver@input.test');
  await RoleRequest.create({ user: user._id, requestedRole: 'student', status: 'approved', approvedAt: new Date(Date.now() - 864e5 * 30) });
  await UserProfile.updateOne({ user: user._id, role: 'student' }, { $set: { completed: true, percent: 100 } }, { upsert: true });
  await Wallet.create({ user: user._id, currency: 'PKR', available: 1000, pending: 0 });
  token = jwt.sign({ sub: String(user._id) }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
  server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port + '/api';
});
after(async () => { server.close(); await mongoose.disconnect(); await mongo.stop(); });

test('sign-in routes answer a clear error when the fields are not text, and show no internal error', async () => {
  const cases = [
    ['/auth/login', { email: ne, password: ne }], ['/auth/login', { email: ['a'], password: 'x' }], ['/auth/login', { email: 'sender@input.test', password: { a: 1 } }], ['/auth/login', { email: 'sender@input.test', password: 123 }], ['/auth/login', { email: 'x'.repeat(300), password: 'x' }],
    ['/auth/login/verify-2fa', { email: ne, code: ne }], ['/auth/forgot-password', { email: ne }], ['/auth/reset-password', { email: ne, code: ne, newPassword: PASSWORD }], ['/auth/refresh', { refreshToken: ne }]
  ];
  for (const [path, body] of cases) {
    const r = await call('POST', path, body);
    assert.equal(r.status, 422, path + ' ' + JSON.stringify(body).slice(0, 60));
    assert.doesNotMatch(r.body.message, /is not a function|Illegal arguments|argument must be/);
  }
  assert.equal((await call('POST', '/auth/logout', { refreshToken: ne })).status, 200);
});

test('a real login still works, with the email in any case and with spaces around it', async () => {
  const r = await call('POST', '/auth/login', { email: '  SENDER@input.test ', password: PASSWORD });
  assert.equal(r.status, 200);
  assert.equal((await call('POST', '/auth/login', { email: 'sender@input.test', password: 'Wrong@Pass123' })).status, 401);
});

test('registration rejects a bad email or name and creates nothing', async () => {
  const good = { fullName: 'New Person', email: 'new@input.test', password: PASSWORD, country: 'PK', city: 'Lahore', acceptedTerms: true };
  const before = await User.countDocuments();
  for (const change of [{ email: 'notmail' }, { email: ne }, { fullName: { a: 1 } }, { fullName: 'x'.repeat(101) }, { phone: '1'.repeat(31) }, { country: { a: 1 } }]) {
    const r = await call('POST', '/auth/register', { ...good, ...change });
    assert.equal(r.status, 422, JSON.stringify(change));
  }
  assert.equal(await User.countDocuments(), before);
});

test('withdrawals and transfers refuse bad amounts and leave the balance alone', async () => {
  const account = { method: 'mobile_wallet', provider: 'JazzCash', accountNumber: '03001234567', accountTitle: 'Sender Person' };
  for (const amount of [-5, 0, 0.001, 1.234, 2e9, 1e308, '10', { $gt: 0 }, null]) {
    assert.equal((await call('POST', '/wallet/withdraw', { amount, currency: 'PKR', ...account }, token)).status, 422, 'withdraw ' + amount);
    assert.equal((await call('POST', '/wallet/transfer', { recipientEmail: 'receiver@input.test', amount, currency: 'PKR' }, token)).status, 422, 'transfer ' + amount);
  }
  assert.equal((await call('POST', '/wallet/transfer', { recipientEmail: 'receiver@input.test', amount: 1, currency: 'PKR', note: { a: 1 } }, token)).status, 422);
  assert.equal((await call('POST', '/wallet/transfer', { recipientEmail: 'receiver@input.test', amount: 1, currency: 'PKR', note: 'x'.repeat(301) }, token)).status, 422);
  assert.equal((await call('POST', '/wallet/transfer', { recipientEmail: ne, amount: 1, currency: 'PKR' }, token)).status, 422);
  assert.equal((await call('POST', '/wallet/withdraw', { amount: 10, currency: 'PKR', ...account, accountTitle: { a: 1 } }, token)).status, 422);
  assert.equal(await balance(), 1000);
});

test('correct withdrawals and transfers still go through', async () => {
  const sent = await call('POST', '/wallet/transfer', { recipientEmail: 'receiver@input.test', amount: 19.99, currency: 'PKR', note: 'Books' }, token);
  assert.equal(sent.status, 200);
  const out = await call('POST', '/wallet/withdraw', { amount: 100.5, currency: 'PKR', method: 'mobile_wallet', provider: 'JazzCash', accountNumber: '03001234567', accountTitle: 'Sender Person' }, token);
  assert.equal(out.status, 200);
  assert.equal(await balance(), 879.51);
  assert.equal((await Wallet.findOne({ user: other._id, currency: 'PKR' }).lean()).available, 19.99);
});

test('a payment kind that does not exist is refused, including names every object has', async () => {
  for (const kind of ['bogus', 'constructor', 'toString', '__proto__']) {
    const r = await call('POST', '/manual-payments/' + kind + '/' + new mongoose.Types.ObjectId(), {}, token);
    assert.ok(r.status >= 400 && r.status < 500, kind + ' ' + r.status);
  }
});
