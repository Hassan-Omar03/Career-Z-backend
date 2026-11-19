process.env.AI_KEY_CHECK_IN_TESTS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../src/services/ai.service');

const realFetch = global.fetch;
const listing = (ids) => async () => ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) });

test('uses the platform default when the key may use it', async () => {
  global.fetch = listing(['gpt-4o-mini', 'gpt-5.4-nano-2026-03-17']);
  try { assert.equal(await ai.detectModel('openai', 'sk-test-key-123'), 'gpt-4o-mini'); } finally { global.fetch = realFetch; }
});

test('picks the one model a restricted key may use', async () => {
  global.fetch = listing(['gpt-5.4-nano-2026-03-17']);
  try { assert.equal(await ai.detectModel('openai', 'sk-test-key-123'), 'gpt-5.4-nano-2026-03-17'); } finally { global.fetch = realFetch; }
});

test('skips image, audio and embedding models and prefers a cheap chat model', async () => {
  global.fetch = listing(['text-embedding-3-small', 'gpt-image-1', 'gpt-5-mini', 'gpt-5']);
  try { assert.equal(await ai.detectModel('openai', 'sk-test-key-123'), 'gpt-5-mini'); } finally { global.fetch = realFetch; }
});

test('returns null when the provider cannot be asked', async () => {
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try { assert.equal(await ai.detectModel('openai', 'sk-test-key-123'), null); assert.equal(await ai.detectModel('perplexity', 'x'), null); } finally { global.fetch = realFetch; }
});
