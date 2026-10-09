const Lesson = require('../models/Lesson');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const CaptionTrack = require('../models/CaptionTrack');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');
const env = require('../config/env');
const media = require('../services/mediaAccessibility.service');

const LANGUAGE_NAMES = { en: 'English', ur: 'Urdu', ar: 'Arabic', hi: 'Hindi', bn: 'Bengali', fa: 'Persian', tr: 'Turkish', fr: 'French', es: 'Spanish', de: 'German', zh: 'Chinese', ps: 'Pashto', pa: 'Punjabi', sd: 'Sindhi' };
const labelFor = (code, suffix) => `${LANGUAGE_NAMES[code] || code.toUpperCase()}${suffix ? ` (${suffix})` : ''}`;

async function teacherLesson(lessonId, userId) {
  const lesson = await Lesson.findById(lessonId);
  if (!lesson) throw new AppError('Lesson not found.', 404);
  const course = await Course.findById(lesson.course).select('teacher institution');
  if (!course || course.teacher.toString() !== userId.toString()) throw new AppError('Only the course teacher can generate subtitles.', 403);
  return { lesson, course };
}

function publicBase(req) {
  if (env.serverUrl) return env.serverUrl.replace(/\/+$/, '');
  const proto = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.headers?.['x-forwarded-host'] || req.headers?.host || `localhost:${env.port}`}`;
}

async function attachToLesson(lesson, track, req) {
  const url = `${publicBase(req)}/api/media-accessibility/tracks/${track.token}.vtt`;
  lesson.captions = [...(lesson.captions || []).filter((c) => c.url !== url), { language: track.language, label: track.label, url }];
  await lesson.save();
  return url;
}

// Only the lesson's OWN media can be transcribed — never an arbitrary URL (no server-side fetching
// of attacker-chosen addresses).
function lessonMediaUrls(lesson) {
  return [lesson.videoUrl, ...(lesson.videoSources || []).map((s) => s.url), ...(lesson.resources || []).map((r) => r.url)].filter((u) => /^https?:\/\//i.test(u || ''));
}

// POST /api/media-accessibility/lessons/:lessonId/transcribe — { mediaUrl?, language? }
const transcribeLesson = asyncHandler(async (req, res) => {
  const { lesson, course } = await teacherLesson(req.params.lessonId, req.user._id);
  const options = lessonMediaUrls(lesson);
  const mediaUrl = req.body?.mediaUrl || options[0];
  if (!mediaUrl) throw new AppError('This lesson has no video or audio to transcribe.', 422);
  if (!options.includes(mediaUrl)) throw new AppError('Choose one of this lesson\'s own video/audio files.', 422);
  const language = req.body?.language ? String(req.body.language).toLowerCase().slice(0, 5) : '';
  let vtt;
  try { vtt = await media.transcribeToVtt({ userId: req.user._id, institutionId: course.institution, mediaUrl, language }); } catch (error) { throw new AppError(error.message, error.statusCode || 502); }
  const code = language || 'en';
  const track = await CaptionTrack.create({ lesson: lesson._id, course: course._id, language: code, label: labelFor(code, 'auto'), source: 'ai_transcript', mediaUrl, vtt, createdBy: req.user._id });
  const url = await attachToLesson(lesson, track, req);
  return created(res, { _id: track._id, language: track.language, label: track.label, url }, 'Subtitles generated and added to the lesson video.');
});

// POST /api/media-accessibility/tracks/:trackId/translate — { language }
const translateTrack = asyncHandler(async (req, res) => {
  const source = await CaptionTrack.findById(req.params.trackId);
  if (!source) throw new AppError('Subtitle track not found.', 404);
  const { lesson } = await teacherLesson(source.lesson, req.user._id);
  const target = String(req.body?.language || '').toLowerCase().trim();
  if (!/^[a-z]{2,3}(-[a-z]{2})?$/.test(target)) throw new AppError('Choose a target language (e.g. ur, ar).', 422);
  if (target === source.language) throw new AppError('That is already the subtitle language.', 422);
  let vtt;
  try { vtt = await media.translateVtt(source.vtt, target); } catch (error) { throw new AppError(`Translation failed: ${error.message}`, error.statusCode || 502); }
  const track = await CaptionTrack.create({ lesson: lesson._id, course: source.course, language: target, label: labelFor(target, 'translated'), source: 'translation', fromTrack: source._id, vtt, createdBy: req.user._id });
  const url = await attachToLesson(lesson, track, req);
  return created(res, { _id: track._id, language: track.language, label: track.label, url }, `Subtitles translated to ${track.label}.`);
});

// GET /api/media-accessibility/lessons/:lessonId/tracks — teacher or enrolled student.
const listTracks = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findById(req.params.lessonId).select('course');
  if (!lesson) throw new AppError('Lesson not found.', 404);
  const course = await Course.findById(lesson.course).select('teacher');
  const allowed = course?.teacher?.toString() === req.user._id.toString() || await Enrollment.exists({ course: lesson.course, student: req.user._id, status: { $ne: 'dropped' } });
  if (!allowed) throw new AppError('Lesson not found.', 404);
  const tracks = await CaptionTrack.find({ lesson: lesson._id }).select('language label source fromTrack token createdAt').sort({ createdAt: 1 });
  return ok(res, tracks.map((t) => ({ _id: t._id, language: t.language, label: t.label, source: t.source, url: `${publicBase(req)}/api/media-accessibility/tracks/${t.token}.vtt` })));
});

// GET /api/media-accessibility/tracks/:token.vtt — public (unguessable token) WebVTT for <track>.
const serveTrack = asyncHandler(async (req, res) => {
  const token = String(req.params.file || '').replace(/\.vtt$/, '');
  if (!/^[a-f0-9]{32}$/.test(token)) throw new AppError('Not found.', 404);
  const track = await CaptionTrack.findOne({ token }).select('vtt');
  if (!track) throw new AppError('Not found.', 404);
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin'); // the frontend runs on another origin
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('text/vtt').send(track.vtt);
});

// DELETE /api/media-accessibility/tracks/:trackId — teacher removes a track (and its lesson link).
const deleteTrack = asyncHandler(async (req, res) => {
  const track = await CaptionTrack.findById(req.params.trackId);
  if (!track) throw new AppError('Subtitle track not found.', 404);
  const { lesson } = await teacherLesson(track.lesson, req.user._id);
  lesson.captions = (lesson.captions || []).filter((c) => !String(c.url).includes(track.token));
  await lesson.save();
  await track.deleteOne();
  return ok(res, { deleted: true }, 'Subtitle track removed.');
});

module.exports = { transcribeLesson, translateTrack, listTracks, serveTrack, deleteTrack, LANGUAGE_NAMES };
