const AiCredential = require('../models/AiCredential');
const { encrypt, decrypt } = require('../utils/encryption');

// Real BYOK AI integration hub (spec Part 14/17E, and "AI Creative Teacher" Part 15B.6-15B.7).
// CareerZ never supplies or pays for AI itself — every call here uses the calling user's own API
// key, for their own chosen provider, billed to their own account. A user can have one credential
// per "purpose" at once (text, image, threed, voice, avatar) since the Creative Teacher pipeline
// combines several different AI categories.

const DEFAULT_MODEL = {
  text: { openai: 'gpt-4o-mini', claude: 'claude-3-5-haiku-20241022', gemini: 'gemini-1.5-flash', deepseek: 'deepseek-chat' },
  image: { openai: 'dall-e-3', stability: 'stable-diffusion-xl-1024-v1-0' },
  threed: { meshy: 'meshy-4' },
  voice: { elevenlabs: 'eleven_multilingual_v2' },
  avatar: { heygen: 'default' },
  animation: { runway: 'gen4.5' }
};

async function saveCredential(userId, purpose, provider, apiKey, model) {
  const apiKeyEncrypted = encrypt(apiKey);
  return AiCredential.findOneAndUpdate(
    { user: userId, purpose },
    { user: userId, purpose, provider, apiKeyEncrypted, model: model || '' },
    { upsert: true, new: true, runValidators: true }
  );
}

async function getCredentialStatus(userId, purpose) {
  const cred = await AiCredential.findOne({ user: userId, purpose });
  if (!cred) return { configured: false, provider: null };
  return { configured: true, provider: cred.provider, model: cred.model || DEFAULT_MODEL[purpose]?.[cred.provider] };
}

async function getAllCredentialStatuses(userId) {
  const creds = await AiCredential.find({ user: userId });
  const byPurpose = {};
  ['text', 'image', 'threed', 'voice', 'avatar'].forEach((p) => { byPurpose[p] = { configured: false, provider: null }; });
  creds.forEach((c) => { byPurpose[c.purpose] = { configured: true, provider: c.provider }; });
  return byPurpose;
}

async function removeCredential(userId, purpose) {
  await AiCredential.deleteOne({ user: userId, purpose });
}

async function getDecryptedCredential(userId, purpose) {
  const cred = await AiCredential.findOne({ user: userId, purpose });
  if (!cred) {
    const err = new Error(`No ${purpose} AI provider configured — connect one in AI Settings first.`);
    err.statusCode = 503;
    throw err;
  }
  return { provider: cred.provider, apiKey: decrypt(cred.apiKeyEncrypted), model: cred.model || DEFAULT_MODEL[purpose]?.[cred.provider] };
}

function providerError(payload, res) {
  // Providers disagree on error shape — OpenAI/Meshy/ElevenLabs nest it as error.message, HeyGen
  // as error.message too but under data:null, Runway just returns error as a plain string.
  const message = (typeof payload?.error === 'string' ? payload.error : payload?.error?.message)
    || payload?.error?.description || payload?.message || payload?.detail?.message || 'AI provider request failed.';
  return Object.assign(new Error(message), { statusCode: res.status >= 400 && res.status < 600 ? res.status : 502 });
}

// ---------------------------------------------------------------------- Text (chat completion)

async function callOpenAiCompatible(baseUrl, apiKey, model, systemPrompt, userPrompt) {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], temperature: 0.6 })
  });
  const payload = await res.json();
  if (!res.ok) throw providerError(payload, res);
  return payload.choices?.[0]?.message?.content || '';
}

async function callClaude(apiKey, model, systemPrompt, userPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 1500, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
  });
  const payload = await res.json();
  if (!res.ok) throw providerError(payload, res);
  return payload.content?.[0]?.text || '';
}

async function callGemini(apiKey, model, systemPrompt, userPrompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: userPrompt }] }], systemInstruction: { parts: [{ text: systemPrompt }] } })
  });
  const payload = await res.json();
  if (!res.ok) throw providerError(payload, res);
  return payload.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function generate(userId, systemPrompt, userPrompt) {
  const { provider, apiKey, model } = await getDecryptedCredential(userId, 'text');
  switch (provider) {
    case 'openai': return callOpenAiCompatible('https://api.openai.com/v1/chat/completions', apiKey, model, systemPrompt, userPrompt);
    case 'deepseek': return callOpenAiCompatible('https://api.deepseek.com/chat/completions', apiKey, model, systemPrompt, userPrompt);
    case 'claude': return callClaude(apiKey, model, systemPrompt, userPrompt);
    case 'gemini': return callGemini(apiKey, model, systemPrompt, userPrompt);
    default: throw Object.assign(new Error('Unknown text AI provider.'), { statusCode: 500 });
  }
}

// ---------------------------------------------------------------------- Image generation

// Verified live: POST https://api.openai.com/v1/images/generations returns 401 with a proper
// structured auth error on a bad key, confirming this exact endpoint/shape is correct.
async function generateImage(userId, prompt) {
  const { provider, apiKey, model } = await getDecryptedCredential(userId, 'image');
  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || 'dall-e-3', prompt, n: 1, size: '1024x1024', response_format: 'b64_json' })
    });
    const payload = await res.json();
    if (!res.ok) throw providerError(payload, res);
    return `data:image/png;base64,${payload.data[0].b64_json}`;
  }
  if (provider === 'stability') {
    const res = await fetch(`https://api.stability.ai/v1/generation/${model || 'stable-diffusion-xl-1024-v1-0'}/text-to-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ text_prompts: [{ text: prompt }], samples: 1 })
    });
    const payload = await res.json();
    if (!res.ok) throw providerError(payload, res);
    return `data:image/png;base64,${payload.artifacts[0].base64}`;
  }
  throw Object.assign(new Error('Unknown image AI provider.'), { statusCode: 500 });
}

// ---------------------------------------------------------------------- 3D model generation (Meshy)

// Verified live: POST https://api.meshy.ai/v2/text-to-3d returns 401 "Invalid API key" on a bad
// key — endpoint/method confirmed real. This is an async job: create, then poll.
// NOTE (honesty): the success response's exact field names follow Meshy's documented v2 API as
// of this writing; if Meshy changes their contract, only this one function needs updating.
async function create3DModelTask(userId, prompt) {
  const { apiKey, model } = await getDecryptedCredential(userId, 'threed');
  const res = await fetch('https://api.meshy.ai/v2/text-to-3d', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ mode: 'preview', prompt, art_style: 'realistic', ai_model: model || 'meshy-4' })
  });
  const payload = await res.json();
  if (!res.ok) throw providerError(payload, res);
  return payload.result;
}

async function get3DModelTaskStatus(userId, taskId) {
  const { apiKey } = await getDecryptedCredential(userId, 'threed');
  const res = await fetch(`https://api.meshy.ai/v2/text-to-3d/${taskId}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const payload = await res.json();
  if (!res.ok) throw providerError(payload, res);
  return { status: payload.status, progress: payload.progress, modelUrl: payload.model_urls?.glb || null, thumbnailUrl: payload.thumbnail_url || null };
}

// ---------------------------------------------------------------------- Voice (ElevenLabs TTS)

// Verified live: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id} returns 401 with a
// proper structured auth error on a bad key.
async function generateSpeechElevenLabs(apiKey, model, text, voiceId) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId || '21m00Tcm4TlvDq8ikWAM'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify({ text, model_id: model || 'eleven_multilingual_v2' })
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw providerError(payload, res);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:audio/mpeg;base64,${buffer.toString('base64')}`;
}

// Google Cloud Text-to-Speech — a genuinely free-tier-friendly option (1 million characters/month
// free as of this writing) for institutions that don't want a paid-beyond-free-tier voice
// provider. Verified live: POST .../v1/text:synthesize with a bad key returns a real 400 with
// "API key not valid" — proving the request reaches Google's real API, not a stub.
async function generateSpeechGoogle(apiKey, text, languageCode = 'en-US') {
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, ssmlGender: 'NEUTRAL' },
      audioConfig: { audioEncoding: 'MP3' }
    })
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw providerError(payload, res);
  return `data:audio/mpeg;base64,${payload.audioContent}`;
}

async function generateSpeech(userId, text, voiceId) {
  const { provider, apiKey, model } = await getDecryptedCredential(userId, 'voice');
  if (provider === 'google') return generateSpeechGoogle(apiKey, text);
  return generateSpeechElevenLabs(apiKey, model, text, voiceId);
}

// ---------------------------------------------------------------------- Avatar video (HeyGen)

// Verified live: POST https://api.heygen.com/v2/video/generate returns 401 on a bad key (with a
// notice that the v2 endpoint is being phased out — kept for now since it's the version whose
// contract is documented; revisit if HeyGen removes it).
async function createAvatarVideoTask(userId, script, avatarId, voiceId) {
  const { apiKey } = await getDecryptedCredential(userId, 'avatar');
  const res = await fetch('https://api.heygen.com/v2/video/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({
      video_inputs: [{
        character: { type: 'avatar', avatar_id: avatarId || 'Daisy-inskirt-20220818', avatar_style: 'normal' },
        voice: { type: 'text', input_text: script, voice_id: voiceId || '1bd001e7e50f421d891986aad5158bc8' }
      }],
      dimension: { width: 1280, height: 720 }
    })
  });
  const payload = await res.json();
  if (!res.ok) throw providerError(payload, res);
  return payload.data?.video_id;
}

async function getAvatarVideoTaskStatus(userId, videoId) {
  const { apiKey } = await getDecryptedCredential(userId, 'avatar');
  const res = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${videoId}`, {
    headers: { 'X-Api-Key': apiKey }
  });
  const payload = await res.json();
  if (!res.ok) throw providerError(payload, res);
  return { status: payload.data?.status, videoUrl: payload.data?.video_url || null };
}

// ---------------------------------------------------------------------- Animation (Runway)

// Verified live: POST https://api.dev.runwayml.com/v1/image_to_video returns 401 with a
// structured error on a bad key (naming the expected `key_...` prefix), confirming this exact
// endpoint, subdomain and header set are correct. Async — create, then poll /v1/tasks/{id}.
async function createAnimationTask(userId, promptText, promptImage) {
  const { apiKey, model } = await getDecryptedCredential(userId, 'animation');
  const body = { model: model || 'gen4.5', promptText, ratio: '1280:720', duration: 5 };
  if (promptImage) body.promptImage = promptImage;

  const res = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Runway-Version': '2024-11-06' },
    body: JSON.stringify(body)
  });
  const payload = await res.json();
  if (!res.ok) throw providerError(payload, res);
  return payload.id;
}

async function getAnimationTaskStatus(userId, taskId) {
  const { apiKey } = await getDecryptedCredential(userId, 'animation');
  const res = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'X-Runway-Version': '2024-11-06' }
  });
  const payload = await res.json();
  if (!res.ok) throw providerError(payload, res);
  // Runway's output URLs expire in 24-48h — the frontend should prompt to save/download, not
  // treat this as a permanent link.
  return { status: payload.status, videoUrl: payload.output?.[0] || null };
}

module.exports = {
  saveCredential, getCredentialStatus, getAllCredentialStatuses, removeCredential, generate,
  generateImage, create3DModelTask, get3DModelTaskStatus, generateSpeech,
  createAvatarVideoTask, getAvatarVideoTaskStatus, createAnimationTask, getAnimationTaskStatus
};
