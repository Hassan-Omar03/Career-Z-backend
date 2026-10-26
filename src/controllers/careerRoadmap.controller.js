const CareerRoadmap = require('../models/CareerRoadmap');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

const MAX_ROADMAPS = 10;
const CATEGORIES = ['skill', 'course', 'project', 'certification', 'experience', 'other'];

function cleanStep(s, i) {
  const title = String(s?.title || '').trim();
  if (!title || title.length > 160) throw new AppError(`Step ${i + 1} needs a title (max 160 characters).`, 422);
  const targetDate = s.targetDate ? new Date(s.targetDate) : null;
  if (targetDate && !Number.isFinite(targetDate.getTime())) throw new AppError(`Step ${i + 1} has an invalid target date.`, 422);
  const status = ['todo', 'in_progress', 'done'].includes(s.status) ? s.status : 'todo';
  return { ...(s._id ? { _id: s._id } : {}), title, detail: String(s.detail || '').slice(0, 1000), category: CATEGORIES.includes(s.category) ? s.category : 'other', targetDate, status, completedAt: status === 'done' ? (s.completedAt || new Date()) : null };
}
function cleanTarget(body) {
  const targetCareer = String(body.targetCareer || '').trim();
  if (!targetCareer || targetCareer.length > 120) throw new AppError('Enter the career you are aiming for (max 120 characters).', 422);
  const horizonMonths = body.horizonMonths === undefined ? 6 : Number(body.horizonMonths);
  if (!Number.isInteger(horizonMonths) || horizonMonths < 1 || horizonMonths > 60) throw new AppError('Plan length must be 1–60 months.', 422);
  return { targetCareer, horizonMonths };
}
async function own(req) { const row = await CareerRoadmap.findOne({ _id: req.params.id, user: req.user._id }); if (!row) throw new AppError('Roadmap not found.', 404); return row; }
async function assertRoom(user) { if ((await CareerRoadmap.countDocuments({ user })) >= MAX_ROADMAPS) throw new AppError(`You can keep up to ${MAX_ROADMAPS} roadmaps. Delete one first.`, 409); }

const list = asyncHandler(async (req, res) => ok(res, await CareerRoadmap.find({ user: req.user._id }).sort({ updatedAt: -1 })));

// POST /api/career-roadmaps — manual roadmap { targetCareer, horizonMonths, steps[] }
const create = asyncHandler(async (req, res) => {
  await assertRoom(req.user._id);
  const steps = Array.isArray(req.body.steps) ? req.body.steps.map(cleanStep) : [];
  return created(res, await CareerRoadmap.create({ user: req.user._id, ...cleanTarget(req.body), steps, source: 'manual' }), 'Roadmap created.');
});

// POST /api/career-roadmaps/generate — { targetCareer, horizonMonths, dataConsent: true, institutionId? }
// Uses the student's own AI key, or an institution AI the student is allowed to use.
const generate = asyncHandler(async (req, res) => {
  const target = cleanTarget(req.body);
  if (req.body.dataConsent !== true) throw new AppError('Confirm that your program, skills and goal may be sent to the AI provider.', 422);
  await assertRoom(req.user._id);
  const profile = await require('../models/StudentProfile').findOne({ user: req.user._id }).lean();
  const facts = [`Target career: ${target.targetCareer}`, `Plan length: ${target.horizonMonths} months`, profile?.program && `Current program: ${profile.program}`, profile?.currentTerm && `Current term: ${profile.currentTerm}`,
    (profile?.skills || []).length && `Existing skills: ${[].concat(profile.skills).join(', ')}`, profile?.careerGoal && `Stated goal: ${profile.careerGoal}`].filter(Boolean).join('\n');
  const system = 'You are a careful career counselor. Return ONLY JSON: {"steps":[{"title":string,"detail":string,"category":"skill"|"course"|"project"|"certification"|"experience","month":integer}]} with 5-12 ordered, concrete, realistic steps. "month" is the month number (1..plan length) the step should be finished by. No text outside the JSON.';
  let text;
  try { text = await require('../services/ai.service').generate(req.user._id, system, facts, req.body.institutionId || undefined); }
  catch (e) {
    // No AI key connected: say so plainly instead of a generic provider error.
    if (e.statusCode === 503 && /configured/i.test(e.message || '')) throw new AppError('Connect your AI provider first: Jobs & Applications → Career Tools → AI provider. Or build the roadmap manually.', 409);
    console.error('[roadmap] AI provider error:', e.statusCode || '', e.message);
    throw new AppError(e.statusCode && e.statusCode < 500 ? e.message : `The AI provider could not create a roadmap right now${e.message ? ` (${String(e.message).slice(0, 160)})` : ''}. Try again in a minute or build it without AI.`, e.statusCode && e.statusCode < 500 ? e.statusCode : 502);
  }
  let parsed;
  try { parsed = JSON.parse(String(text).slice(String(text).indexOf('{'), String(text).lastIndexOf('}') + 1)); } catch { parsed = null; }
  const raw = Array.isArray(parsed?.steps) ? parsed.steps.slice(0, 20) : [];
  if (!raw.length) throw new AppError('The AI reply was not a usable roadmap. Try again or build it manually.', 502);
  const now = new Date();
  const steps = raw.map((s, i) => {
    const m = Math.min(target.horizonMonths, Math.max(1, Number.parseInt(s.month, 10) || Math.ceil(((i + 1) / raw.length) * target.horizonMonths)));
    return cleanStep({ title: String(s.title || '').slice(0, 160), detail: s.detail, category: s.category, targetDate: new Date(now.getFullYear(), now.getMonth() + m, now.getDate()) }, i);
  });
  return created(res, await CareerRoadmap.create({ user: req.user._id, ...target, steps, source: 'ai' }), 'Roadmap generated. Review and edit the steps.');
});

// PATCH /api/career-roadmaps/:id — edit target and/or replace steps
const update = asyncHandler(async (req, res) => {
  const row = await own(req);
  if (req.body.targetCareer !== undefined || req.body.horizonMonths !== undefined) Object.assign(row, cleanTarget({ targetCareer: req.body.targetCareer ?? row.targetCareer, horizonMonths: req.body.horizonMonths ?? row.horizonMonths }));
  if (req.body.steps !== undefined) { if (!Array.isArray(req.body.steps)) throw new AppError('steps must be a list.', 422); row.steps = req.body.steps.map(cleanStep); }
  await row.save();
  return ok(res, row, 'Roadmap saved.');
});

// PATCH /api/career-roadmaps/:id/steps/:stepId — { status }
const setStep = asyncHandler(async (req, res) => {
  const row = await own(req);
  const step = row.steps.id(req.params.stepId);
  if (!step) throw new AppError('Step not found.', 404);
  if (!['todo', 'in_progress', 'done'].includes(req.body.status)) throw new AppError('Status must be todo, in_progress or done.', 422);
  step.status = req.body.status; step.completedAt = req.body.status === 'done' ? new Date() : null;
  await row.save();
  return ok(res, row);
});

const remove = asyncHandler(async (req, res) => { const row = await own(req); await row.deleteOne(); return ok(res, null, 'Roadmap deleted.'); });

module.exports = { list, create, generate, update, setStep, remove };
