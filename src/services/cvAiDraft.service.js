const Resume = require('../models/Resume');
const AiCredential = require('../models/AiCredential');
const AppError = require('../utils/AppError');
const aiService = require('./ai.service');
const autofill = require('./resumeAutofill.service');

// "Write my CV with AI": with the person's own connected AI key, turn their notes plus what
// CareerZ already knows about them into a CV draft for the builder. The draft is returned, never
// saved: the person reviews and edits it, then saves it themselves.

const SYSTEM = `You write CVs. Reply with ONE JSON object only, no prose and no code fences, with exactly these keys:
{"headline": string, "summary": string, "location": string, "experienceLevel": "entry"|"mid"|"senior"|"lead"|"",
 "education": [{"institution": string, "degree": string, "year": string}],
 "experience": [{"title": string, "company": string, "duration": string, "description": string}],
 "skills": [string], "languages": [string], "certifications": [string]}
Rules: use ONLY facts the person gave or that appear in their records. Never invent employers, schools, degrees,
dates, certificates or numbers. Leave a field empty ("" or []) when it is unknown. Improve wording: a clear headline,
a 3-4 sentence summary, and achievement-focused experience descriptions. Write in English.`;

const str = (v, max) => (typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim().slice(0, max) : '');
const list = (v, max, n) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : []);
const rows = (v, fields, n) => (Array.isArray(v) ? v.filter((r) => r && typeof r === 'object').slice(0, n)
  .map((r) => Object.fromEntries(fields.map(([k, max]) => [k, str(r[k], max)]))).filter((r) => Object.values(r).some(Boolean)) : []);

function parseDraft(text) {
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { obj = null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new AppError('The AI reply was not a usable CV. Try again, or add more detail.', 502);
  return {
    headline: str(obj.headline, 160), summary: str(obj.summary, 3000), location: str(obj.location, 160),
    experienceLevel: ['entry', 'mid', 'senior', 'lead'].includes(obj.experienceLevel) ? obj.experienceLevel : '',
    education: rows(obj.education, [['institution', 200], ['degree', 200], ['year', 40]], 10),
    experience: rows(obj.experience, [['title', 160], ['company', 200], ['duration', 80], ['description', 2000]], 15),
    skills: list(obj.skills, 60, 40), languages: list(obj.languages, 60, 15), certifications: list(obj.certifications, 160, 20)
  };
}

const configured = async (userId) => Boolean(await AiCredential.exists({ user: userId, purpose: 'text', scope: 'user' }));

async function draft(user, { notes, targetRole } = {}) {
  const about = String(notes || '').trim();
  if (about.length < 20) throw new AppError('Tell the AI about yourself first (studies, work, skills), at least a couple of sentences.', 422);
  if (about.length > 4000) throw new AppError('Keep it under 4000 characters.', 422);
  if (!(await configured(user._id))) throw new AppError('Connect your AI provider in Career Tools first. Without it, use the manual builder.', 409);
  const resume = await Resume.findOne({ user: user._id }).lean();
  const records = await autofill.draftFor(user).catch(() => ({}));
  delete records.sources;
  const context = { name: user.fullName, city: user.city || '', country: user.country || '', currentCv: resume ? { headline: resume.headline, summary: resume.summary, education: resume.education, experience: resume.experience, skills: resume.skills } : null, careerzRecords: records };
  const prompt = `Target role: ${str(targetRole, 120) || 'not given'}\n\nAbout me (my own words):\n${about}\n\nMy existing CV and CareerZ records (JSON):\n${JSON.stringify(context).slice(0, 6000)}`;
  let text;
  try { text = await aiService.generate(user._id, SYSTEM, prompt); } catch (e) { throw new AppError(e.message || 'The AI provider did not answer.', e.statusCode === 503 ? 409 : 502); }
  return parseDraft(text);
}

module.exports = { draft, parseDraft, configured };
