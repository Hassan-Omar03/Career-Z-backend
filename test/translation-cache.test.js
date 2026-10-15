const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Self-hosted LibreTranslate is slow on the VPS: strings go in chunks of 20, Chinese uses its
// LibreTranslate code, and every translated string is cached so the next visitor is instant.
process.env.NODE_ENV = 'test';
const env = require('../src/config/env');
const TranslationCache = require('../src/models/TranslationCache');
let mongo, calls, failNext;
const realFetch = global.fetch;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Object.assign(env.translation, { provider: 'libretranslate', libretranslateUrl: 'http://lt.test', googleTranslateApiKey: '', webEngine: false });
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (failNext) { failNext = false; return { ok: false, status: 500, json: async () => ({ error: 'overloaded' }) }; }
    return { ok: true, status: 200, json: async () => ({ translatedText: body.q.map((q) => `${body.target}:${q}`) }) };
  };
});
after(async () => { global.fetch = realFetch; await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => { calls = []; failNext = false; });

const { translateTexts } = require('../src/services/translation.service');

test('page strings are chunked, cached across requests and Chinese uses zh-Hans', async () => {
  const texts = Array.from({ length: 45 }, (_, i) => `Label ${i}`);
  const first = await translateTexts([...texts, 'Label 0'], 'ur');
  assert.equal(first.length, 46);
  assert.equal(first[0], 'ur:Label 0');
  assert.equal(first[45], 'ur:Label 0');
  assert.deepEqual(calls.map((c) => c.q.length), [20, 20, 5]);
  assert.equal(await TranslationCache.countDocuments({ lang: 'ur' }), 45);

  calls = [];
  const again = await translateTexts(['Label 3', 'New label'], 'ur');
  assert.deepEqual(again, ['ur:Label 3', 'ur:New label']);
  assert.deepEqual(calls.map((c) => c.q), [['New label']]);

  calls = [];
  assert.deepEqual(await translateTexts(['Dashboard'], 'zh'), ['zh-Hans:Dashboard']);
  assert.equal(calls[0].target, 'zh-Hans');
});

test('a failed provider call is not cached and is retried next time', async () => {
  failNext = true;
  await assert.rejects(translateTexts(['Retry me'], 'ar'), /overloaded/);
  assert.equal(await TranslationCache.countDocuments({ lang: 'ar' }), 0);
  assert.deepEqual(await translateTexts(['Retry me'], 'ar'), ['ar:Retry me']);
});
