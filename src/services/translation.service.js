const env = require('../config/env');

// Two swappable free providers (spec Part 16F "Smart Language Engine" — Dynamic Translation),
// chosen at runtime by TRANSLATION_PROVIDER. No local dictionary, no per-language hardcoded
// strings anywhere — every string is translated live.
//
// - mymemory (default): translated.net's free API. Reliable (a real company's infrastructure,
//   not a volunteer server), but capped at 5,000 words/day per calling IP anonymously, or
//   10,000/day if MYMEMORY_EMAIL is set (still free, just register any email at mymemory.net).
// - libretranslate: fully open-source, genuinely unlimited and free forever — but only if
//   self-hosted on the client's own always-on server (LIBRETRANSLATE_URL). Public LibreTranslate
//   mirrors exist but are volunteer-run and were observed going down during development, so they
//   are not used as a default here.

function isTranslationConfigured() {
  if (env.translation.provider === 'libretranslate') return Boolean(env.translation.libretranslateUrl);
  return true; // MyMemory needs no key at all — it's the always-available default
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
  const res = await fetch(`${env.translation.libretranslateUrl.replace(/\/+$/, '')}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: texts,
      source: 'en',
      target: targetLang,
      format: 'text',
      ...(env.translation.libretranslateApiKey ? { api_key: env.translation.libretranslateApiKey } : {})
    })
  });
  const payload = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(payload.error || 'LibreTranslate request failed.'), { statusCode: res.status });
  }
  // Self-hosted LibreTranslate returns { translatedText: string | string[] } depending on whether
  // q was a single string or an array — normalize to an array either way.
  return Array.isArray(payload.translatedText) ? payload.translatedText : [payload.translatedText];
}

async function translateTexts(texts, targetLang) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (env.translation.provider === 'libretranslate') {
    if (!env.translation.libretranslateUrl) {
      throw Object.assign(new Error('LIBRETRANSLATE_URL is not set — either configure your self-hosted instance or set TRANSLATION_PROVIDER=mymemory.'), { statusCode: 503 });
    }
    return translateViaLibreTranslate(texts, targetLang);
  }
  return translateViaMyMemory(texts, targetLang);
}

module.exports = { translateTexts, isTranslationConfigured };
