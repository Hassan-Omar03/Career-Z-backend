const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
const app = require('../src/app');
const Fee = require('../src/models/Fee');

let mongo, server, base;
const lookup = async (code) => {
  const r = await fetch(base + '/institution-fees/receipts/verify/' + encodeURIComponent(code));
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Fee.collection.insertOne({ title: 'Tuition', receiptNumber: 'RCPT-ABC-1', verifyCode: 'qr-code-1', amount: 500, paidAmount: 500, currency: 'PKR', status: 'paid' });
  server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port + '/api';
});
after(async () => { server.close(); await mongoose.disconnect(); await mongo.stop(); });

test('a fee receipt is found by the number printed on it and by its QR code', async () => {
  for (const code of ['RCPT-ABC-1', 'qr-code-1']) {
    const r = await lookup(code);
    assert.equal(r.status, 200, code);
    assert.equal(r.body.data.receiptNumber, 'RCPT-ABC-1');
  }
  assert.equal((await lookup('RCPT-NOPE')).status, 404);
});
