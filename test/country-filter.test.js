// Audit BUG-001: the country filter matches a country whether it was saved as a code or a name.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
const Country = require('../src/models/Country');
const { countryMatch } = require('../src/utils/countryMatch');
let mongo;
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Country.create({ name: 'Pakistan', code: 'PK' }); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

test('"Pakistan" and "PK" each match PK, Pakistan and PAKISTAN, and nothing else', async () => {
  for (const q of ['Pakistan', 'pk', ' PK ']) {
    const re = await countryMatch(q);
    for (const stored of ['PK', 'Pakistan', 'PAKISTAN']) assert.ok(re.test(stored), `${q} -> ${stored}`);
    assert.ok(!re.test('SAUDI ARABIA') && !re.test('PKR'), q);
  }
  assert.equal(await countryMatch(''), null);
  const unknown = await countryMatch('Testland.*');
  assert.ok(unknown.test('Testland.*') && !unknown.test('Testlandxx'), 'typed text is matched literally');
});
