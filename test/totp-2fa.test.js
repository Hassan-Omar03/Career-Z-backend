// Master 5.7: two-step sign-in with an authenticator app (TOTP), with one-use backup codes.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'totp-test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notifyAdmins', async () => []);
const app = require('../src/app');
const User = require('../src/models/User');
const totp = require('../src/services/totp.service');

let mongo, server, base, user;
const token = (u) => jwt.sign({ sub: String(u._id) }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
const call = async (method, p, body, auth) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + token(auth) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  user = await User.create({ fullName: 'Two Step', email: 'two@step.test', passwordHash: await User.hashPassword('Good@Pass123'), emailVerified: true, roles: ['student'], status: 'active' });
  server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { if (server) await new Promise((r) => server.close(r)); await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test('RFC 6238 test vector', () => {
  // Secret "12345678901234567890" in base32; time 59s -> 94287082 (8 digits) -> last 6 = 287082.
  assert.equal(totp.codeAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1), '287082');
});

test('setup, enable, sign in with the app code, no replay, backup codes, lock after wrong codes', async () => {
  const setup = await call('POST', '/auth/2fa/totp/setup', {}, user);
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const secret = setup.body.data.secret;
  assert.match(setup.body.data.qr, /^data:image\/png;base64,/);
  assert.equal((await call('POST', '/auth/2fa/totp/enable', { code: '000000' }, user)).status, 422);
  const enabled = await call('POST', '/auth/2fa/totp/enable', { code: totp.codeAt(secret, totp.stepNow()) }, user);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const backups = enabled.body.data.backupCodes;
  assert.equal(backups.length, 8);
  assert.equal(enabled.body.data.user.totp, undefined, 'the secret never reaches the browser');

  const login = await call('POST', '/auth/login', { email: 'two@step.test', password: 'Good@Pass123' });
  assert.equal(login.body.data.twoFactorRequired, true);
  assert.equal(login.body.data.method, 'totp');
  // The code used to enable cannot sign in again; the next step's code can.
  assert.equal((await call('POST', '/auth/login/verify-2fa', { email: 'two@step.test', code: totp.codeAt(secret, totp.stepNow()) })).status, 400);
  const next = totp.codeAt(secret, totp.stepNow() + 1);
  const [a, b] = await Promise.all([call('POST', '/auth/login/verify-2fa', { email: 'two@step.test', code: next }), call('POST', '/auth/login/verify-2fa', { email: 'two@step.test', code: next })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400], 'the same code works once even when sent twice at the same moment');
  const signedIn = a.status === 200 ? a : b;
  assert.ok(signedIn.body.data.accessToken);
  assert.equal(signedIn.body.data.user.totp, undefined);

  assert.equal((await call('POST', '/auth/login/verify-2fa', { email: 'two@step.test', code: backups[0] })).status, 200);
  assert.equal((await call('POST', '/auth/login/verify-2fa', { email: 'two@step.test', code: backups[0] })).status, 400, 'a backup code works once');

  await User.updateOne({ _id: user._id }, { $set: { 'totp.failures': 0 } }); // the wrong attempts above count too
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/auth/login/verify-2fa', { email: 'two@step.test', code: '111111' })).status, 400);
  assert.equal((await call('POST', '/auth/login/verify-2fa', { email: 'two@step.test', code: '111111' })).status, 400);
  assert.equal((await call('POST', '/auth/login/verify-2fa', { email: 'two@step.test', code: backups[1] })).status, 429, 'locked after five wrong codes');
  await User.updateOne({ _id: user._id }, { $set: { 'totp.lockedUntil': null } });

  assert.equal((await call('POST', '/auth/2fa/totp/disable', { code: '123' }, user)).status, 422);
  const off = await call('POST', '/auth/2fa/totp/disable', { code: backups[1] }, user);
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal((await User.findById(user._id)).twoFactorMethod, 'email');
});
