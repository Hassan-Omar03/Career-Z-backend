const env = require('../config/env');

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

const LIBRETRANSLATE_TIMEOUT_MS = 6000; // "kaam karna band kar de" / overloaded == slow, so a hard
// timeout counts as a failure just as much as an HTTP error, triggering the same fallback.

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
  const res = await fetchWithTimeout(`${env.translation.libretranslateUrl.replace(/\/+$/, '')}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: texts,
      source: 'en',
      target: targetLang,
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

async function translateTexts(texts, targetLang) {
  if (!Array.isArray(texts) || texts.length === 0) return [];

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
