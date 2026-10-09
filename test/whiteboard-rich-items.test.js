const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const User = require('../src/models/User');
const Course = require('../src/models/Course');
const Enrollment = require('../src/models/Enrollment');
const LiveClassSession = require('../src/models/LiveClassSession');
const liveTools = require('../src/controllers/liveTools.controller');

let mongo, teacher, session;
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([User, Course, Enrollment, LiveClassSession].map((m) => m.deleteMany({})));
  teacher = await User.create({ fullName: 't', email: 't@wb.test', passwordHash: 'x' });
  const course = await Course.create({ title: 'Maths', teacher: teacher._id });
  session = await LiveClassSession.create({ institution: new mongoose.Types.ObjectId(), course: course._id, classSection: new mongoose.Types.ObjectId(), teacher: teacher._id, createdBy: teacher._id, title: 'L', scheduledStart: new Date(), scheduledEnd: new Date(Date.now() + 3600000), roomName: `wb-${Math.random()}`, status: 'live' });
});
const draw = (operation) => new Promise((resolve, reject) => {
  const res = { status() { return this; }, json(v) { resolve(v.data); return this; } };
  Promise.resolve(liveTools.update({ params: { id: session.id }, user: { _id: teacher._id }, body: { action: 'board', operation } }, res, reject)).catch(reject);
});

test('equations, arrows, mind maps and images are stored on the shared board', async () => {
  await draw({ type: 'math', x: 10, y: 10, text: 'x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}', color: '#000000' });
  await draw({ type: 'arrow', x: 10, y: 10, x2: 200, y2: 100, color: '#ff0000' });
  await draw({ type: 'mindmap', x: 100, y: 100, x2: 600, y2: 450, nodes: [{ id: 'r', label: 'Photosynthesis', parent: null }, { id: 'a', label: 'Light', parent: 'r' }, { id: 'b', label: 'Chlorophyll', parent: 'r' }] });
  const state = await draw({ type: 'image', x: 50, y: 50, x2: 300, y2: 250, url: 'https://res.cloudinary.com/demo/image/upload/cell.png' });
  assert.deepEqual(state.board.map((b) => b.type), ['math', 'arrow', 'mindmap', 'image']);
  assert.equal(state.board[2].nodes.length, 3);
  assert.equal(state.board[3].url, 'https://res.cloudinary.com/demo/image/upload/cell.png');
});

test('malformed rich items are rejected', async () => {
  await assert.rejects(draw({ type: 'math', x: 1, y: 1, text: '' }), { statusCode: 422 });
  await assert.rejects(draw({ type: 'image', x: 1, y: 1, x2: 2, y2: 2, url: 'javascript:alert(1)' }), { statusCode: 422 });
  await assert.rejects(draw({ type: 'mindmap', x: 1, y: 1, x2: 2, y2: 2, nodes: [{ id: 'a', label: 'A', parent: null }, { id: 'b', label: 'B', parent: null }] }), { statusCode: 422 });
  await assert.rejects(draw({ type: 'mindmap', x: 1, y: 1, x2: 2, y2: 2, nodes: [{ id: 'a', label: 'A', parent: null }, { id: 'b', label: 'B', parent: 'zzz' }] }), { statusCode: 422 });
  await assert.rejects(draw({ type: 'hologram', x: 1, y: 1 }), { statusCode: 422 });
});
