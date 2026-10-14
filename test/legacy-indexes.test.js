const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// A database built by an older schema had aicredentials.user_1_purpose_1 unique on every
// credential, so connecting an institution key failed with E11000 for anyone who already had a
// personal key. repairLegacyIndexes must rebuild it as the schema's scope:'user' partial index.
process.env.NODE_ENV = 'test';
const { repairLegacyIndexes } = require('../src/config/legacyIndexes');
const aiService = require('../src/services/ai.service');
const AiCredential = require('../src/models/AiCredential');
const Institution = require('../src/models/Institution');
const User = require('../src/models/User');
let mongo;

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
});
after(async () => { await mongoose.disconnect(); await mongo?.stop(); });

test('legacy unscoped AI credential index is rebuilt so personal and institution keys coexist', async () => {
  const col = mongoose.connection.db.collection('aicredentials');
  await col.createIndex({ user: 1, purpose: 1 }, { name: 'user_1_purpose_1', unique: true });
  const owner = await User.create({ fullName: 'Index Owner', email: 'idx@owner.local', passwordHash: 'x', roles: ['institution'] });
  const inst = await Institution.create({ name: 'Index School', slug: 'index-school', type: 'school', country: 'PK', owner: owner._id });

  await aiService.saveCredential(owner._id, 'text', 'openai', 'sk-personal-key-123');
  await assert.rejects(aiService.saveInstitutionCredential(inst._id, owner._id, 'text', 'openai', 'sk-institution-key-1'), /E11000/);

  await repairLegacyIndexes(mongoose.connection.db);
  const rebuilt = (await col.indexes()).find((i) => i.name === 'user_1_purpose_1');
  assert.deepEqual(rebuilt.partialFilterExpression, { scope: 'user' });
  assert.equal(rebuilt.unique, true);

  await aiService.saveInstitutionCredential(inst._id, owner._id, 'text', 'openai', 'sk-institution-key-1');
  assert.equal(await AiCredential.countDocuments({ user: owner._id, purpose: 'text' }), 2);
  // Still one personal key per purpose.
  await assert.rejects(AiCredential.create({ user: owner._id, purpose: 'text', scope: 'user', provider: 'openai', apiKeyEncrypted: 'x', keyPreview: 'x' }), /E11000/);
  // A second run leaves the correct index alone.
  await repairLegacyIndexes(mongoose.connection.db);
  assert.equal((await col.indexes()).filter((i) => i.name === 'user_1_purpose_1').length, 1);
});
