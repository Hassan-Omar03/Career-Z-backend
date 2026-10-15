const crypto = require('crypto');
const mongoose = require('mongoose');
const env = require('../config/env');
const TranslationCache = require('../models/TranslationCache');

// Three swappable providers (spec Part 16F "Smart Language Engine" — Dynamic Translation), no
// local dictionary, no per-language hardcoded strings — every string is translated live.
//
// - libretranslate: fully open-source, genuinely unlimited and free forever, self-hosted
//   (LIBRETRANSLATE_URL, e.g. on the client's own VPS via Docker). This is the primary when
//   configured.
// - google: Google Cloud Translation API (GOOGLE_TRANSLATE_API_KEY) — used automatically as a
//   FALLBACK the moment LibreTranslate is slow, overloaded or down, so translation never actually
//   stops for users. Never used as the primary on its own (it's a paid-per-character API).
// - mymemory (default when nothing else is configured): translated.net's free API, no key needed.
//
// In front of all of them runs Google's keyless web translator (TRANSLATION_WEB, on by default):
// live neural translation with no API key. LibreTranslate's small models got everyday interface
// words wrong in Urdu (Scholarships -> "scholar ship", Logout -> "Login"), so it is now only the
// fallback when the web engine is unreachable.

// Self-hosted LibreTranslate on a 2-CPU VPS needs roughly 0.25-1s per string, so a page's
// strings go in small chunks, each with a timeout sized for that, and two chunks at a time. A
// timeout still counts as a failure, triggering the same fallback as an HTTP error.
const LIBRETRANSLATE_CHUNK = 20;
const LIBRETRANSLATE_CONCURRENCY = 2;
const LIBRETRANSLATE_TIMEOUT_MS = 45000;
// The app's language codes where LibreTranslate names a language differently.
const LIBRETRANSLATE_CODES = { zh: 'zh-Hans' };

function isTranslationConfigured() {
  if (env.translation.provider === 'libretranslate') return Boolean(env.translation.libretranslateUrl);
  return true; // MyMemory needs no key at all — it's the always-available default
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function translateViaMyMemory(texts, targetLang) {
  const CONCURRENCY = 8;
  const results = new Array(texts.length);
  let cursor = 0;

  async function worker() {
    while (cursor < texts.length) {
      const i = cursor++;
      const text = texts[i];
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}${env.translation.myMemoryEmail ? `&de=${encodeURIComponent(env.translation.myMemoryEmail)}` : ''}`;
      const res = await fetch(url);
      const payload = await res.json();
      if (payload.responseStatus && Number(payload.responseStatus) >= 400) {
        throw Object.assign(new Error(payload.responseDetails || 'MyMemory translation failed.'), { statusCode: 502 });
      }
      if (payload.quotaFinished) {
        throw Object.assign(new Error('Daily free translation quota reached — try again tomorrow, or switch TRANSLATION_PROVIDER to a self-hosted LibreTranslate instance for unlimited use.'), { statusCode: 429 });
      }
      results[i] = payload.responseData?.translatedText || text;
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker));
  return results;
}

async function translateViaLibreTranslate(texts, targetLang) {
  const chunks = [];
  for (let i = 0; i < texts.length; i += LIBRETRANSLATE_CHUNK) chunks.push(texts.slice(i, i + LIBRETRANSLATE_CHUNK));
  const results = new Array(chunks.length);
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const i = next++;
      results[i] = await translateLibreChunk(chunks[i], targetLang);
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIBRETRANSLATE_CONCURRENCY, chunks.length) }, worker));
  return results.flat();
}

async function translateLibreChunk(texts, targetLang) {
  const res = await fetchWithTimeout(`${env.translation.libretranslateUrl.replace(/\/+$/, '')}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: texts,
      source: 'en',
      target: LIBRETRANSLATE_CODES[targetLang] || targetLang,
      format: 'text',
      ...(env.translation.libretranslateApiKey ? { api_key: env.translation.libretranslateApiKey } : {})
    })
  }, LIBRETRANSLATE_TIMEOUT_MS);
  const payload = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(payload.error || 'LibreTranslate request failed.'), { statusCode: res.status });
  }
  // Self-hosted LibreTranslate returns { translatedText: string | string[] } depending on whether
  // q was a single string or an array — normalize to an array either way.
  return Array.isArray(payload.translatedText) ? payload.translatedText : [payload.translatedText];
}

// ---------------------------------------------------------------------- Google web (no key)
const WEB_CHUNK_CHARS = 4000;
const WEB_CHUNK_ITEMS = 60;
const WEB_CONCURRENCY = 3;
const WEB_TIMEOUT_MS = 15000;
const WEB_CODES = { zh: 'zh-CN' };
const WEB_PROVIDER = 'google-web';

async function translateViaWeb(texts, targetLang) {
  // Leading/trailing spaces belong to the page layout, not the sentence: translate the trimmed
  // text and put the spaces back.
  const parts = texts.map((t) => String(t).match(/^(\s*)([\s\S]*?)(\s*)$/));
  const chunks = [];
  let current = [], size = 0;
  parts.forEach((m, i) => {
    if (current.length && (current.length >= WEB_CHUNK_ITEMS || size + m[2].length > WEB_CHUNK_CHARS)) { chunks.push(current); current = []; size = 0; }
    current.push(i); size += m[2].length;
  });
  if (current.length) chunks.push(current);

  const out = new Array(texts.length);
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const idx = chunks[next++];
      const translated = await translateWebChunk(idx.map((i) => parts[i][2]), targetLang);
      idx.forEach((i, j) => { out[i] = parts[i][1] + tidyPunctuation(parts[i][2], translated[j]) + parts[i][3]; });
    }
  }
  await Promise.all(Array.from({ length: Math.min(WEB_CONCURRENCY, chunks.length) }, worker));
  return out;
}

async function translateWebChunk(texts, targetLang) {
  const body = new URLSearchParams();
  texts.forEach((q) => body.append('q', q));
  const res = await fetchWithTimeout(`https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&tl=${encodeURIComponent(WEB_CODES[targetLang] || targetLang)}&format=text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body
  }, WEB_TIMEOUT_MS);
  if (!res.ok) throw Object.assign(new Error(`Web translator answered ${res.status}.`), { statusCode: 502 });
  let payload = await res.json();
  if (!Array.isArray(payload) || texts.length === 1) payload = [payload];
  // Some answers come back as [translation, detectedLanguage] pairs.
  const out = payload.map((item) => (Array.isArray(item) ? item[0] : item));
  if (out.length !== texts.length || out.some((s) => typeof s !== 'string')) throw Object.assign(new Error('Web translator returned an unexpected answer.'), { statusCode: 502 });
  return out;
}

// A button label like "Apply Now" must not come back as a full sentence ending in "." or "۔".
function tidyPunctuation(source, translated) {
  if (/[.!?。۔]$/.test(source)) return translated;
  return translated.replace(/\s*[.。۔]$/, '');
}

async function translateViaGoogle(texts, targetLang) {
  const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(env.translation.googleTranslateApiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, source: 'en', target: targetLang, format: 'text' })
  });
  const payload = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(payload.error?.message || 'Google Translate request failed.'), { statusCode: res.status });
  }
  return payload.data.translations.map((t) => t.translatedText);
}

// ---------------------------------------------------------------------- Shared cache
// In-memory first, then MongoDB (TranslationCache), then the provider. Only strings the provider
// actually returned are stored, so a failed or timed-out request is retried next time.
const memory = new Map();
const QUALITY_PROVIDERS = [WEB_PROVIDER, 'google'];
const MEMORY_LIMIT = 50000;
const keyOf = (text) => crypto.createHash('sha1').update(text).digest('hex');

function remember(lang, key, translated) {
  if (memory.size >= MEMORY_LIMIT) memory.delete(memory.keys().next().value);
  memory.set(`${lang}:${key}`, translated);
}

async function translateTexts(texts, targetLang) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const keys = texts.map((t) => keyOf(String(t)));
  const out = keys.map((k) => memory.get(`${targetLang}:${k}`));
  const dbReady = mongoose.connection.readyState === 1;

  let missing = [...new Set(keys.filter((k, i) => out[i] === undefined))];
  if (missing.length && dbReady) {
    const filter = { lang: targetLang, key: { $in: missing } };
    if (env.translation.webEngine) filter.provider = { $in: QUALITY_PROVIDERS };
    const rows = await TranslationCache.find(filter).select('key translated').lean().catch(() => []);
    for (const row of rows) remember(targetLang, row.key, row.translated);
    keys.forEach((k, i) => { if (out[i] === undefined) out[i] = memory.get(`${targetLang}:${k}`); });
    missing = [...new Set(keys.filter((k, i) => out[i] === undefined))];
  }
  if (!missing.length) return out;

  const sources = missing.map((k) => String(texts[keys.indexOf(k)]));
  const { translated, provider } = await translateUncached(sources, targetLang);
  const fresh = [];
  missing.forEach((k, i) => {
    const value = translated[i];
    if (typeof value !== 'string' || !value.trim()) return;
    remember(targetLang, k, value);
    fresh.push({ updateOne: { filter: { lang: targetLang, key: k }, update: { $set: { text: sources[i], translated: value, provider } }, upsert: true } });
  });
  if (fresh.length && dbReady) await TranslationCache.bulkWrite(fresh, { ordered: false }).catch((err) => console.error('[translation] cache write failed:', err.message));
  return keys.map((k, i) => out[i] ?? memory.get(`${targetLang}:${k}`) ?? String(texts[i]));
}

// Returns { translated, provider } so the cache records which engine produced each string.
async function translateUncached(texts, targetLang) {
  if (env.translation.webEngine) {
    try {
      return { translated: await translateViaWeb(texts, targetLang), provider: WEB_PROVIDER };
    } catch (err) {
      console.error('[translation] web translator unavailable, using the fallback provider:', err.message);
    }
  }
  return { translated: await translateViaProvider(texts, targetLang), provider: env.translation.provider };
}

async function translateViaProvider(texts, targetLang) {
  if (env.translation.provider === 'libretranslate') {
    if (!env.translation.libretranslateUrl) {
      throw Object.assign(new Error('LIBRETRANSLATE_URL is not set — either configure your self-hosted instance or set TRANSLATION_PROVIDER=mymemory.'), { statusCode: 503 });
    }
    try {
      return await translateViaLibreTranslate(texts, targetLang);
    } catch (err) {
      // The whole point of a self-hosted primary + fallback: an overloaded/timed-out/down
      // LibreTranslate instance never actually stops translation for users.
      if (env.translation.googleTranslateApiKey) {
        console.error('[translation] LibreTranslate failed, falling back to Google Translate:', err.message);
        return translateViaGoogle(texts, targetLang);
      }
      throw err;
    }
  }

  if (env.translation.provider === 'google') {
    if (!env.translation.googleTranslateApiKey) {
      throw Object.assign(new Error('GOOGLE_TRANSLATE_API_KEY is not set.'), { statusCode: 503 });
    }
    return translateViaGoogle(texts, targetLang);
  }

  return translateViaMyMemory(texts, targetLang);
}

module.exports = { translateTexts, isTranslationConfigured };
