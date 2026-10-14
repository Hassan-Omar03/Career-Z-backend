const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// A key encrypted under another server secret must produce a clear "reconnect" message, not
// Node's raw "Unsupported state or unable to authenticate data".
process.env.NODE_ENV = 'test';
const ai = require('../src/services/ai.service');
const AiCredential = require('../src/models/AiCredential');
const User = require('../src/models/User');
let mongo;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

test('a stored key that no longer decrypts asks the user to reconnect it', async () => {
  const user = await User.create({ fullName: 'Old Key', email: 'oldkey@t.local', passwordHash: 'x', roles: ['teacher'] });
  await ai.saveCredential(user._id, 'text', 'openai', 'sk-working-key-123');
  const { decrypt } = require('../src/utils/encryption');
  assert.equal(decrypt((await AiCredential.findOne({ user: user._id })).apiKeyEncrypted), 'sk-working-key-123');

  // Same layout as a real ciphertext, but sealed with a different secret.
  const [iv, tag, data] = (await AiCredential.findOne({ user: user._id })).apiKeyEncrypted.split(':');
  await AiCredential.updateOne({ user: user._id }, { apiKeyEncrypted: [iv, tag.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')), data].join(':') });
  await assert.rejects(ai.generate(user._id, 'system', 'prompt'), (err) => {
    assert.equal(err.statusCode, 409);
    assert.match(err.message, /Your saved text API key can no longer be read by the server\. Disconnect it and connect the key again\./);
    return true;
  });
});
