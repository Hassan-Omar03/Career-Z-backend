const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
process.env.CLOUDINARY_CLOUD_NAME = 'demo'; process.env.CLOUDINARY_API_KEY = 'key'; process.env.CLOUDINARY_API_SECRET = 'secret';
const User = require('../src/models/User');
const Backup = require('../src/models/Backup');
const backupCtrl = require('../src/controllers/backup.controller');
const service = require('../src/services/backupFiles.service');

const OLD = 'https://res.cloudinary.com/demo/image/upload/v1/careerz/avatar.png';
const NEW = 'https://res.cloudinary.com/demo/image/upload/v2/careerz-restored/avatar.png';
const PNG = Buffer.from('89504e470d0a1a0a-fake-image-bytes');
let mongo, admin, alive;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all([User, Backup].map((m) => m.init())); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([User, Backup].map((m) => m.deleteMany({})));
  admin = await User.create({ fullName: 'Admin', email: 'admin@backup.test', passwordHash: 'x', profilePhoto: OLD });
  alive = true;
  // Fake network: the original file exists until "deleted"; Cloudinary upload returns NEW.
  mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    if (String(url).startsWith('https://api.cloudinary.com/')) return new Response(JSON.stringify({ secure_url: NEW }), { status: 200 });
    if (url === OLD) {
      if (!alive) return new Response('gone', { status: 404 });
      return opts.method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('nope', { status: 404 });
  });
});

function invoke(handler, { user, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(c) { status = c; return this; }, json(v) { resolve({ status, body: v }); return this; } };
    Promise.resolve(handler({ user, params, body }, res, reject)).catch(reject);
  });
}

test('uploaded-file URLs are found anywhere in documents, with the documents that use them', () => {
  const refs = service.collectUploadUrls([{ name: 'User', documents: [{ _id: 'u1', photo: OLD, nested: { list: [OLD, 'https://example.com/x'] } }] }]);
  assert.deepEqual([...refs.keys()], [OLD]);
  assert.deepEqual(refs.get(OLD), [{ collection: 'User', id: 'u1' }]);
  assert.deepEqual(service.replaceDeep({ a: OLD, b: [OLD], c: 1 }, OLD, NEW), { a: NEW, b: [NEW], c: 1 });
});

test('a backup stores the actual file bytes; a lost file is re-uploaded and every reference repointed', async () => {
  const made = (await invoke(backupCtrl.createBackup, { user: admin })).body.data;
  assert.equal(made.files.count, 1);
  const uploads = (await invoke(backupCtrl.listBackupUploads, { user: admin, params: { id: made._id } })).body.data;
  assert.equal(uploads[0].url, OLD);
  assert.equal(uploads[0].size, PNG.length);
  const folder = path.join(__dirname, '..', 'backups', made.folder);
  assert.deepEqual(fs.readFileSync(path.join(folder, 'files', uploads[0].key)), PNG);

  // Nothing missing yet → nothing to restore.
  assert.equal((await invoke(backupCtrl.restoreBackupUploads, { user: admin, params: { id: made._id } })).body.data.toRestore.length, 0);
  alive = false; // the file is deleted from Cloudinary
  const dry = (await invoke(backupCtrl.restoreBackupUploads, { user: admin, params: { id: made._id } })).body.data;
  assert.equal(dry.dryRun, true);
  assert.equal(dry.toRestore.length, 1);
  assert.equal((await User.findById(admin._id)).profilePhoto, OLD); // dry run changes nothing
  const done = (await invoke(backupCtrl.restoreBackupUploads, { user: admin, params: { id: made._id }, body: { confirm: dry.confirmationRequired } })).body.data;
  assert.deepEqual(done.restored, [{ from: OLD, to: NEW, documents: 1 }]);
  assert.equal((await User.findById(admin._id)).profilePhoto, NEW);
  fs.rmSync(folder, { recursive: true, force: true });
});

test('a corrupted backup copy is refused instead of being re-uploaded', async () => {
  const made = (await invoke(backupCtrl.createBackup, { user: admin })).body.data;
  const folder = path.join(__dirname, '..', 'backups', made.folder);
  const [entry] = service.readManifest(folder);
  fs.writeFileSync(path.join(folder, 'files', entry.key), Buffer.from('tampered'));
  alive = false;
  const done = (await invoke(backupCtrl.restoreBackupUploads, { user: admin, params: { id: made._id }, body: { confirm: `RESTORE FILES ${made._id}` } })).body.data;
  assert.equal(done.restored.length, 0);
  assert.match(done.failed[0].error, /corrupted/);
  assert.equal((await User.findById(admin._id)).profilePhoto, OLD);
  fs.rmSync(folder, { recursive: true, force: true });
});
