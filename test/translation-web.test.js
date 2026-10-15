const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// The keyless web translator runs first; LibreTranslate is only the fallback, and old
// LibreTranslate rows in the cache are replaced instead of being served.
process.env.NODE_ENV = 'test';
const env = require('../src/config/env');
const TranslationCache = require('../src/models/TranslationCache');
let mongo, webCalls, libreCalls, webDown;
const realFetch = global.fetch;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Object.assign(env.translation, { provider: 'libretranslate', libretranslateUrl: 'http://lt.test', googleTranslateApiKey: '', webEngine: true });
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://translate.googleapis.com/')) {
      const tl = new URL(url).searchParams.get('tl');
      const q = new URLSearchParams(options.body.toString()).getAll('q');
      webCalls.push({ tl, q });
      if (webDown) return { ok: false, status: 429, json: async () => ({}) };
      const answers = q.map((s) => (s === 'Apply Now' ? 'ابھی اپلائی کریں۔' : `${tl}:${s}`));
      return { ok: true, status: 200, json: async () => (answers.length === 1 ? answers[0] : answers) };
    }
    const body = JSON.parse(options.body);
    libreCalls.push(body);
    return { ok: true, status: 200, json: async () => ({ translatedText: body.q.map((q) => `libre:${q}`) }) };
  };
});
after(async () => { global.fetch = realFetch; await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => { webCalls = []; libreCalls = []; webDown = false; });

const { translateTexts } = require('../src/services/translation.service');

test('the web translator is used first, keeps spaces and drops a full stop the label never had', async () => {
  const out = await translateTexts(['  Dashboard ', 'Apply Now', 'Done.'], 'ur');
  assert.deepEqual(out, ['  ur:Dashboard ', 'ابھی اپلائی کریں', 'ur:Done.']);
  assert.deepEqual(webCalls[0].q, ['Dashboard', 'Apply Now', 'Done.']);
  assert.equal(libreCalls.length, 0);
  assert.equal(await TranslationCache.countDocuments({ lang: 'ur', provider: 'google-web' }), 3);
  assert.deepEqual(await translateTexts(['zh label'], 'zh'), ['zh-CN:zh label']);
  assert.equal(await translateTexts(['Single'], 'ar').then((r) => r[0]), 'ar:Single');
});

test('old LibreTranslate cache rows are replaced by the web translation', async () => {
  const key = require('crypto').createHash('sha1').update('Scholarships').digest('hex');
  await TranslationCache.create({ lang: 'fa', key, text: 'Scholarships', translated: 'wrong', provider: 'libretranslate' });
  assert.deepEqual(await translateTexts(['Scholarships'], 'fa'), ['fa:Scholarships']);
  const row = await TranslationCache.findOne({ lang: 'fa', key }).lean();
  assert.equal(row.provider, 'google-web');
  assert.equal(row.translated, 'fa:Scholarships');
});

test('when the web translator is down, LibreTranslate answers and the page still translates', async () => {
  webDown = true;
  assert.deepEqual(await translateTexts(['Offline label'], 'de'), ['libre:Offline label']);
  assert.equal(libreCalls.length, 1);
  assert.equal((await TranslationCache.findOne({ lang: 'de' }).lean()).provider, 'libretranslate');
});

test('large pages are split into several requests', async () => {
  const texts = Array.from({ length: 130 }, (_, i) => `Item number ${i}`);
  const out = await translateTexts(texts, 'tr');
  assert.equal(out[129], 'tr:Item number 129');
  assert.deepEqual(webCalls.map((c) => c.q.length), [60, 60, 10]);
});
