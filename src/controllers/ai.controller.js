const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const aiService = require('../services/ai.service');

const PURPOSES = ['text', 'image', 'threed', 'voice', 'avatar', 'animation'];
const PROVIDERS_BY_PURPOSE = {
  text: ['openai', 'claude', 'gemini', 'deepseek'],
  image: ['openai', 'stability'],
  threed: ['meshy'],
  voice: ['elevenlabs', 'google'],
  avatar: ['heygen'],
  animation: ['runway']
};
const MAX_PROMPT_LENGTH = 4000;

const FEATURE_PROMPTS = {
  teacher_notes: 'You are a teaching assistant. Given a topic, write clear, well-structured class notes with headings and bullet points suitable for students. Keep it concise and accurate.',
  teacher_quiz: 'You are a teaching assistant. Given a topic, generate 5 multiple-choice quiz questions with 4 options each and mark the correct answer. Format clearly.',
  teacher_lesson_plan: 'You are a teaching assistant. Given a topic and grade level, write a structured lesson plan: objectives, materials, activities (with rough timing), and an assessment idea.',
  student_study_help: 'You are a patient study tutor. Explain the concept the student asks about clearly, with a simple example. Keep it focused and not overly long.',
  student_notes_summary: 'You are a study assistant. Summarize the given notes/text into clear, concise bullet points a student can revise from quickly.',
  career_advice: 'You are a career advisor for students. Given their interests/situation, give practical, specific advice about courses, skills, or career paths — not generic platitudes.',
  cv_feedback: 'You are a CV/resume reviewer. Given the CV text, give specific, actionable feedback on what to improve — wording, structure, missing sections. Be direct and concise.',
  cover_letter: 'You are a cover letter writer. Given the job details and the applicant\'s background, write a professional, specific cover letter (not generic filler) in 3-4 short paragraphs.',
  linkedin_optimize: 'You are a LinkedIn profile optimizer. Given the person\'s current headline/summary/experience text, rewrite it to be more compelling and keyword-relevant, and list 3-5 specific improvement suggestions.',
  interview_coach: 'You are an interview coach. Given the job role and the candidate\'s background, generate 5 likely interview questions for that role, and for each one give a short tip on how to answer it well.',
  teacher_slides: 'You are a presentation slide generator for teachers. Given a topic (and grade level if mentioned), generate 6 to 10 presentation slides. Output ONLY in this exact format, nothing else — no intro, no explanation:\n---SLIDE---\nTITLE: <slide title>\n- <bullet point>\n- <bullet point>\n- <bullet point>\n(repeat ---SLIDE--- for each slide, 3-5 short bullets per slide, no sub-bullets, no markdown formatting inside bullets)',
  video_lesson_script: 'You are a scriptwriter for short educational videos. Given lesson content/a topic, break it into 4 to 8 scenes that together teach the material. Output ONLY in this exact format, nothing else — no intro, no explanation:\n---SCENE---\nTITLE: <short on-screen title, under 8 words>\nNARRATION: <2-4 natural spoken sentences a narrator would read aloud for this scene — no bullet points, write it as continuous speech>\n- <on-screen bullet point>\n- <on-screen bullet point>\n(repeat ---SCENE--- for each scene, 2-4 short on-screen bullets per scene, narration should sound natural when read aloud, not like a list)'
};

// GET /api/ai/config — all 5 purposes' connection status at once (text/image/threed/voice/avatar).
const getConfig = asyncHandler(async (req, res) => {
  const statuses = await aiService.getAllCredentialStatuses(req.user._id);
  return ok(res, statuses);
});

// PUT /api/ai/config — save/replace one purpose's provider + API key.
const saveConfig = asyncHandler(async (req, res) => {
  const { purpose, provider, apiKey, model } = req.body;
  if (!purpose || !PURPOSES.includes(purpose)) throw new AppError(`purpose must be one of: ${PURPOSES.join(', ')}.`, 422);
  if (!provider || !PROVIDERS_BY_PURPOSE[purpose].includes(provider)) {
    throw new AppError(`For ${purpose}, provider must be one of: ${PROVIDERS_BY_PURPOSE[purpose].join(', ')}.`, 422);
  }
  if (!apiKey || apiKey.trim().length < 8) throw new AppError('A valid API key is required.', 422);

  await aiService.saveCredential(req.user._id, purpose, provider, apiKey.trim(), model?.trim());
  return ok(res, { configured: true, purpose, provider }, 'AI provider connected.');
});

// DELETE /api/ai/config/:purpose
const removeConfig = asyncHandler(async (req, res) => {
  const { purpose } = req.params;
  if (!PURPOSES.includes(purpose)) throw new AppError(`purpose must be one of: ${PURPOSES.join(', ')}.`, 422);
  await aiService.removeCredential(req.user._id, purpose);
  return ok(res, null, 'AI provider disconnected.');
});

// POST /api/ai/generate — text features (notes, quiz, slides, career advice, ...).
const generate = asyncHandler(async (req, res) => {
  const { feature, prompt } = req.body;
  if (!feature || !FEATURE_PROMPTS[feature]) throw new AppError(`feature must be one of: ${Object.keys(FEATURE_PROMPTS).join(', ')}.`, 422);
  if (!prompt || !prompt.trim()) throw new AppError('prompt is required.', 422);
  if (prompt.length > MAX_PROMPT_LENGTH) throw new AppError(`Prompt too long — max ${MAX_PROMPT_LENGTH} characters.`, 422);

  try {
    const result = await aiService.generate(req.user._id, FEATURE_PROMPTS[feature], prompt.trim());
    return ok(res, { result });
  } catch (err) {
    throw new AppError(err.message, err.statusCode || 500);
  }
});

// POST /api/ai/image — AI Creative Teacher: Graphics/Images (spec 15B.6).
const image = asyncHandler(async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) throw new AppError('prompt is required.', 422);
  if (prompt.length > 1000) throw new AppError('Prompt too long — max 1000 characters.', 422);
  try {
    const imageDataUrl = await aiService.generateImage(req.user._id, prompt.trim());
    return ok(res, { imageDataUrl });
  } catch (err) {
    throw new AppError(err.message, err.statusCode || 500);
  }
});

// POST /api/ai/3d-model — AI Creative Teacher: 3D Models (spec 15B.6). Async — returns a taskId
// to poll via GET /api/ai/3d-model/:taskId.
const create3DModel = asyncHandler(async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) throw new AppError('prompt is required.', 422);
  try {
    const taskId = await aiService.create3DModelTask(req.user._id, prompt.trim());
    return ok(res, { taskId });
  } catch (err) {
    throw new AppError(err.message, err.statusCode || 500);
  }
});

const get3DModelStatus = asyncHandler(async (req, res) => {
  try {
    const status = await aiService.get3DModelTaskStatus(req.user._id, req.params.taskId);
    return ok(res, status);
  } catch (err) {
    throw new AppError(err.message, err.statusCode || 500);
  }
});

// POST /api/ai/voice — AI Creative Teacher: narration voice (part of "Full AI Video" spec 15B.7).
const voice = asyncHandler(async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) throw new AppError('text is required.', 422);
  if (text.length > 2500) throw new AppError('Text too long — max 2500 characters.', 422);
  try {
    const audioDataUrl = await aiService.generateSpeech(req.user._id, text.trim());
    return ok(res, { audioDataUrl });
  } catch (err) {
    throw new AppError(err.message, err.statusCode || 500);
  }
});

// POST /api/ai/avatar-video — AI Creative Teacher: full AI video with a talking avatar (spec
// 15B.7 "AI Voice, AI Avatar"). Async — poll via GET /api/ai/avatar-video/:videoId.
const createAvatarVideo = asyncHandler(async (req, res) => {
  const { script, avatarId, voiceId } = req.body;
  if (!script || !script.trim()) throw new AppError('script is required.', 422);
  if (script.length > 2500) throw new AppError('Script too long — max 2500 characters.', 422);
  try {
    const videoId = await aiService.createAvatarVideoTask(req.user._id, script.trim(), avatarId, voiceId);
    return ok(res, { videoId });
  } catch (err) {
    throw new AppError(err.message, err.statusCode || 500);
  }
});

const getAvatarVideoStatus = asyncHandler(async (req, res) => {
  try {
    const status = await aiService.getAvatarVideoTaskStatus(req.user._id, req.params.videoId);
    return ok(res, status);
  } catch (err) {
    throw new AppError(err.message, err.statusCode || 500);
  }
});

// POST /api/ai/animation — AI Creative Teacher: Animation (spec 15B.6, Runway). Async — poll via
// GET /api/ai/animation/:taskId. promptImage is optional (gen4.5 supports text-only per Runway's
// current guide); when given it must be a real public HTTPS image URL Runway can fetch.
const createAnimation = asyncHandler(async (req, res) => {
  const { promptText, promptImage } = req.body;
  if (!promptText || !promptText.trim()) throw new AppError('promptText is required.', 422);
  if (promptText.length > 1000) throw new AppError('promptText too long — max 1000 characters.', 422);
  try {
    const taskId = await aiService.createAnimationTask(req.user._id, promptText.trim(), promptImage?.trim() || null);
    return ok(res, { taskId });
  } catch (err) {
    throw new AppError(err.message, err.statusCode || 500);
  }
});

const getAnimationStatus = asyncHandler(async (req, res) => {
  try {
    const status = await aiService.getAnimationTaskStatus(req.user._id, req.params.taskId);
    return ok(res, status);
  } catch (err) {
    throw new AppError(err.message, err.statusCode || 500);
  }
});

module.exports = {
  getConfig, saveConfig, removeConfig, generate,
  image, create3DModel, get3DModelStatus, voice, createAvatarVideo, getAvatarVideoStatus,
  createAnimation, getAnimationStatus
};
