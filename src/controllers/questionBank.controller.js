const QuestionBankItem = require('../models/QuestionBankItem');
const Institution = require('../models/Institution');
const TeacherProfile = require('../models/TeacherProfile');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

// Institutions whose shared question bank this user can use: owned, staff of, or teaching at.
async function bankInstitutionsFor(userId) {
  const [owned, staffOf, teacher] = await Promise.all([
    Institution.find({ owner: userId }).select('_id'),
    Institution.find({ 'staff.user': userId }).select('_id'),
    TeacherProfile.findOne({ user: userId }).select('institutions')
  ]);
  return new Set([...owned, ...staffOf].map((i) => i._id.toString()).concat((teacher?.institutions || []).map(String)));
}

async function canManage(item, userId) {
  if (item.createdBy.toString() === userId.toString()) return true;
  if (!item.institution) return false;
  const institution = await Institution.findById(item.institution).select('owner staff');
  if (!institution) return false;
  if (institution.owner.toString() === userId.toString()) return true;
  return institution.staff.some((s) => s.user.toString() === userId.toString() && (s.permissions || []).includes('questionbank:manage'));
}

function cleanQuestion(body) {
  const type = ['mcq', 'short', 'long'].includes(body.type) ? body.type : 'mcq';
  const text = String(body.text || '').trim();
  const marks = Number(body.marks);
  if (!text) throw new AppError('Question text is required.', 422);
  if (!Number.isFinite(marks) || marks <= 0) throw new AppError('Marks must be greater than zero.', 422);
  const options = type === 'mcq' ? (Array.isArray(body.options) ? body.options.map((o) => String(o).trim()).filter(Boolean) : []) : [];
  const correctOption = type === 'mcq' ? Number(body.correctOption) : null;
  if (type === 'mcq' && (options.length < 2 || !Number.isInteger(correctOption) || correctOption < 0 || correctOption >= options.length)) {
    throw new AppError('An MCQ needs at least two options and one valid correct option.', 422);
  }
  return {
    text, type, options, correctOption, marks,
    subject: String(body.subject || '').trim(), topic: String(body.topic || '').trim(),
    difficulty: ['easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : 'medium',
    tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 15) : []
  };
}

// GET /api/question-bank?institution=&subject=&topic=&difficulty=&type=&q=
const listQuestions = asyncHandler(async (req, res) => {
  const allowed = await bankInstitutionsFor(req.user._id);
  const { institution, subject, topic, difficulty, type, q } = req.query;
  if (institution && !allowed.has(String(institution))) throw new AppError('You do not have access to this institution\'s question bank.', 403);
  const scope = institution
    ? { institution }
    : { $or: [{ institution: { $in: [...allowed] } }, { institution: null, createdBy: req.user._id }] };
  const filter = { ...scope, archived: false };
  if (subject) filter.subject = String(subject);
  if (topic) filter.topic = new RegExp(String(topic).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (difficulty) filter.difficulty = String(difficulty);
  if (type) filter.type = String(type);
  if (q) filter.text = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const items = await QuestionBankItem.find(filter).populate('createdBy', 'fullName').sort({ updatedAt: -1 }).limit(300);
  return ok(res, items);
});

// POST /api/question-bank — body { institution?, text, type, options, correctOption, marks, subject, topic, difficulty, tags }
const createQuestion = asyncHandler(async (req, res) => {
  const institution = req.body.institution || null;
  if (institution && !(await bankInstitutionsFor(req.user._id)).has(String(institution))) throw new AppError('You can only add to the question bank of an institution you teach at or manage.', 403);
  const item = await QuestionBankItem.create({ ...cleanQuestion(req.body), institution, createdBy: req.user._id });
  return created(res, item, 'Question saved to the bank.');
});

// PATCH /api/question-bank/:id — creator, or owner / staff with 'questionbank:manage'.
const updateQuestion = asyncHandler(async (req, res) => {
  const item = await QuestionBankItem.findById(req.params.id);
  if (!item || item.archived) throw new AppError('Question not found.', 404);
  if (!(await canManage(item, req.user._id))) throw new AppError('Only the question\'s author or a question-bank manager can edit it.', 403);
  Object.assign(item, cleanQuestion({ ...item.toObject(), ...req.body }));
  await item.save();
  return ok(res, item, 'Question updated.');
});

// DELETE /api/question-bank/:id — archived, not erased (exams already copied it).
const archiveQuestion = asyncHandler(async (req, res) => {
  const item = await QuestionBankItem.findById(req.params.id);
  if (!item || item.archived) throw new AppError('Question not found.', 404);
  if (!(await canManage(item, req.user._id))) throw new AppError('Only the question\'s author or a question-bank manager can remove it.', 403);
  item.archived = true;
  await item.save();
  return ok(res, { archived: true }, 'Question removed from the bank.');
});

// Used by createExam: copies picked bank questions into the exam (exams keep their own copy, so
// later bank edits never change a paper students already sat).
async function resolveForExam(ids, userId, courseInstitution) {
  const unique = [...new Set(ids.map(String))];
  const items = await QuestionBankItem.find({ _id: { $in: unique }, archived: false });
  if (items.length !== unique.length) throw new AppError('Some selected bank questions no longer exist.', 422);
  for (const item of items) {
    const usable = item.institution
      ? courseInstitution && item.institution.toString() === courseInstitution.toString()
      : item.createdBy.toString() === userId.toString();
    if (!usable) throw new AppError('A selected question belongs to a different institution\'s bank.', 403);
  }
  await QuestionBankItem.updateMany({ _id: { $in: unique } }, { $inc: { timesUsed: 1 } });
  const byId = new Map(items.map((i) => [i._id.toString(), i]));
  return unique.map((id) => { const i = byId.get(id); return { text: i.text, type: i.type, options: i.options, correctOption: i.correctOption, marks: i.marks }; });
}

module.exports = { listQuestions, createQuestion, updateQuestion, archiveQuestion, resolveForExam };
