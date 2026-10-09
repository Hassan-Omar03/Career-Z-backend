// Audio/video transcription → WebVTT subtitles → translated subtitles.
const AiCredential = require('../models/AiCredential');
const { decrypt } = require('../utils/encryption');
const { translateTexts } = require('./translation.service');

const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // OpenAI Whisper's upload limit

// Speech-to-text uses OpenAI Whisper with the teacher's (or institution's) OpenAI key from AI
// Settings — the 'text' or 'voice' credential, whichever is an OpenAI key.
async function openAiKeyFor(userId, institutionId) {
  const scopes = [
    ...(institutionId ? [{ institution: institutionId, scope: 'institution' }] : []),
    { user: userId, scope: 'user' }
  ];
  for (const scope of scopes) {
    const cred = await AiCredential.findOne({ ...scope, purpose: { $in: ['voice', 'text'] }, provider: 'openai' });
    if (cred) return decrypt(cred.apiKeyEncrypted);
  }
  const err = new Error('Automatic transcription needs an OpenAI key (Whisper). Add an OpenAI key under AI Settings (Text or Voice), then try again.');
  err.statusCode = 503;
  throw err;
}

async function transcribeToVtt({ userId, institutionId, mediaUrl, language, fetchImpl = fetch }) {
  const apiKey = await openAiKeyFor(userId, institutionId);
  const media = await fetchImpl(mediaUrl, { signal: AbortSignal.timeout(120000) });
  if (!media.ok) throw Object.assign(new Error(`Could not download the lesson media (HTTP ${media.status}).`), { statusCode: 422 });
  const declared = Number(media.headers.get('content-length') || 0);
  if (declared > MAX_MEDIA_BYTES) throw Object.assign(new Error('This media file is larger than 25 MB. Upload an audio-only version (e.g. MP3) for transcription.'), { statusCode: 422 });
  const bytes = Buffer.from(await media.arrayBuffer());
  if (bytes.length > MAX_MEDIA_BYTES) throw Object.assign(new Error('This media file is larger than 25 MB. Upload an audio-only version (e.g. MP3) for transcription.'), { statusCode: 422 });
  const name = (new URL(mediaUrl).pathname.split('/').pop() || 'lesson.mp4').slice(0, 100);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: media.headers.get('content-type') || 'application/octet-stream' }), name);
  form.append('model', 'whisper-1');
  form.append('response_format', 'vtt');
  if (language) form.append('language', language);
  const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(600000) });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = JSON.parse(text).error?.message || text; } catch { /* plain text */ }
    throw Object.assign(new Error(`Transcription failed: ${String(message).slice(0, 300)}`), { statusCode: response.status === 401 ? 503 : 502 });
  }
  if (!text.trim().startsWith('WEBVTT')) throw Object.assign(new Error('Transcription service returned no subtitles.'), { statusCode: 502 });
  return text;
}

// Splits WebVTT into header + cues ({ timing, lines }) so only spoken text gets translated.
function parseVtt(vtt) {
  const blocks = String(vtt).replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  const header = blocks.shift() || 'WEBVTT';
  const cues = blocks.map((block) => {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex < 0) return { raw: block };
    return { id: lines.slice(0, timingIndex).join('\n'), timing: lines[timingIndex], text: lines.slice(timingIndex + 1).join('\n') };
  });
  return { header, cues };
}

function buildVtt({ header, cues }) {
  return `${header}\n\n${cues.map((c) => (c.raw !== undefined ? c.raw : [c.id, c.timing, c.text].filter(Boolean).join('\n'))).join('\n\n')}\n`;
}

async function translateVtt(vtt, targetLanguage, translate = translateTexts) {
  const parsed = parseVtt(vtt);
  const cues = parsed.cues.filter((c) => c.raw === undefined && c.text.trim());
  for (let i = 0; i < cues.length; i += 40) {
    const batch = cues.slice(i, i + 40);
    const translated = await translate(batch.map((c) => c.text), targetLanguage);
    batch.forEach((c, j) => { c.text = String(translated?.[j] ?? c.text); });
  }
  return buildVtt(parsed);
}

module.exports = { transcribeToVtt, translateVtt, parseVtt, buildVtt, MAX_MEDIA_BYTES };
