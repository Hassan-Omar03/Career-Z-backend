const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const translation = require('../src/services/translation.service');
mock.method(translation, 'translateTexts', async (texts, lang) => texts.map((t) => `[${lang}] ${t}`));
const User = require('../src/models/User');
const Course = require('../src/models/Course');
const Lesson = require('../src/models/Lesson');
const Enrollment = require('../src/models/Enrollment');
const CaptionTrack = require('../src/models/CaptionTrack');
const AiCredential = require('../src/models/AiCredential');
require('../src/models/ContentVersion');
const { encrypt } = require('../src/utils/encryption');
const ctrl = require('../src/controllers/mediaAccessibility.controller');
const media = require('../src/services/mediaAccessibility.service');

const VIDEO = 'https://cdn.example/lesson1.mp4';
const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello class\n\n00:00:02.000 --> 00:00:04.000\nToday: photosynthesis\n';
let mongo, teacher, student, outsider, lesson, whisperCalls;

before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all([User, Course, Lesson, Enrollment, CaptionTrack, AiCredential].map((m) => m.init())); });
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([User, Course, Lesson, Enrollment, CaptionTrack, AiCredential].map((m) => m.deleteMany({})));
  [teacher, student, outsider] = await User.create(['teacher', 'student', 'out'].map((n) => ({ fullName: n, email: `${n}@media.test`, passwordHash: 'x' })));
  const course = await Course.create({ title: 'Biology', teacher: teacher._id });
  lesson = await Lesson.create({ course: course._id, title: 'Photosynthesis', videoUrl: VIDEO });
  await Enrollment.create({ student: student._id, course: course._id, status: 'active' });
  whisperCalls = 0;
  mock.method(globalThis, 'fetch', async (url) => {
    if (url === VIDEO) return new Response(Buffer.from('fake-mp4'), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '8' } });
    if (url === 'https://api.openai.com/v1/audio/transcriptions') { whisperCalls += 1; return new Response(VTT, { status: 200 }); }
    return new Response('not found', { status: 404 });
  });
});

function invoke(handler, { user, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200; const headers = {};
    const res = { status(c) { status = c; return this; }, set(k, v) { headers[k] = v; return this; }, type(t) { headers.type = t; return this; },
      json(v) { resolve({ status, body: v, headers }); return this; }, send(v) { resolve({ status, body: v, headers }); return this; } };
    Promise.resolve(handler({ user, params, body, headers: { host: 'api.test', 'x-forwarded-proto': 'https' }, protocol: 'https' }, res, reject)).catch(reject);
  });
}

test('without an OpenAI key the teacher gets a clear message', async () => {
  await assert.rejects(invoke(ctrl.transcribeLesson, { user: teacher, params: { lessonId: lesson.id } }), (e) => e.statusCode === 503 && /OpenAI key/.test(e.message));
});

test('transcribe → subtitles attached to the lesson video → translated track → served as public VTT', async () => {
  await AiCredential.create({ user: teacher._id, scope: 'user', purpose: 'text', provider: 'openai', apiKeyEncrypted: encrypt('sk-test'), keyPreview: 'sk-...test' });
  const made = (await invoke(ctrl.transcribeLesson, { user: teacher, params: { lessonId: lesson.id }, body: { language: 'en' } })).body.data;
  assert.equal(whisperCalls, 1);
  assert.equal(made.label, 'English (auto)');
  let saved = await Lesson.findById(lesson._id);
  assert.equal(saved.captions.length, 1);
  assert.match(saved.captions[0].url, /^https:\/\/api\.test\/api\/media-accessibility\/tracks\/[a-f0-9]{32}\.vtt$/);

  const urdu = (await invoke(ctrl.translateTrack, { user: teacher, params: { trackId: made._id }, body: { language: 'ur' } })).body.data;
  assert.equal(urdu.label, 'Urdu (translated)');
  saved = await Lesson.findById(lesson._id);
  assert.equal(saved.captions.length, 2);
  const token = urdu.url.split('/').pop();
  const served = await invoke(ctrl.serveTrack, { params: { file: token } });
  assert.equal(served.headers.type, 'text/vtt');
  assert.match(served.body, /00:00:00.000 --> 00:00:02.000\n\[ur\] Hello class/);
  assert.match(served.body, /\[ur\] Today: photosynthesis/);
  assert.equal((await invoke(ctrl.listTracks, { user: student, params: { lessonId: lesson.id } })).body.data.length, 2);
  await assert.rejects(invoke(ctrl.listTracks, { user: outsider, params: { lessonId: lesson.id } }), { statusCode: 404 });
});

test('only the course teacher can generate, and only from the lesson\'s own media (no arbitrary URLs)', async () => {
  await AiCredential.create({ user: teacher._id, scope: 'user', purpose: 'text', provider: 'openai', apiKeyEncrypted: encrypt('sk-test'), keyPreview: 'sk-...test' });
  await assert.rejects(invoke(ctrl.transcribeLesson, { user: student, params: { lessonId: lesson.id } }), { statusCode: 403 });
  await assert.rejects(invoke(ctrl.transcribeLesson, { user: teacher, params: { lessonId: lesson.id }, body: { mediaUrl: 'http://169.254.169.254/latest/meta-data' } }), { statusCode: 422 });
  assert.equal(whisperCalls, 0);
  await assert.rejects(invoke(ctrl.serveTrack, { params: { file: '../../etc/passwd' } }), { statusCode: 404 });
});

test('VTT parse/build keeps timings and cue ids untouched', () => {
  const parsed = media.parseVtt('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHi\n');
  assert.equal(parsed.cues[0].id, '1');
  assert.equal(media.buildVtt(parsed), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHi\n');
});
