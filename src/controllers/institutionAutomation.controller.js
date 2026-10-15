const mongoose = require('mongoose');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { ok } = require('../utils/apiResponse');
const Institution = require('../models/Institution');
const TimetableEntry = require('../models/TimetableEntry');
const { hasStaffPermission } = require('../utils/staffRoles');
const { notifyMany } = require('../services/notification.service');
const timetable = require('../services/timetableGenerator.service');
const { campusReport } = require('../services/campusReport.service');
const assistant = require('../services/institutionAssistant.service');

// Auto timetable, per-campus reports and the institution AI assistant's actions.

const asAppError = (err) => (err instanceof AppError ? err : new AppError(err.message, err.statusCode || 500));
async function institutionFor(req, ...permissions) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError('Institution not found.', 404);
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  if (permissions.length && !hasStaffPermission(institution, req.user._id, ...permissions)) throw new AppError(`This needs the owner or the "${permissions[0]}" staff permission.`, 403);
  return institution;
}
const sectionIds = (body) => (Array.isArray(body.sections) ? body.sections.filter((id) => mongoose.isValidObjectId(id)) : []);

// POST /api/institutions/:id/timetable/auto/preview — draft only, nothing saved.
const previewTimetable = asyncHandler(async (req, res) => {
  const institution = await institutionFor(req, 'timetable:manage');
  try { return ok(res, await timetable.generate(institution._id, { ...req.body, sections: sectionIds(req.body) })); } catch (err) { throw asAppError(err); }
});

// POST /api/institutions/:id/timetable/auto/apply — rebuilds the draft from the same inputs (the
// client's copy is never trusted), replaces those sections' timetables and tells each teacher.
const applyTimetable = asyncHandler(async (req, res) => {
  const institution = await institutionFor(req, 'timetable:manage');
  if (institution.verificationStatus !== 'approved') throw new AppError('This institution must be verified by Super Admin before it can do this.', 403);
  let draft;
  try { draft = await timetable.generate(institution._id, { ...req.body, sections: sectionIds(req.body) }); } catch (err) { throw asAppError(err); }
  if (draft.unplaced.length && !req.body.acceptPartial) throw new AppError('Some classes could not be placed. Review the draft and confirm to save it anyway.', 409);
  const ids = draft.sections.map((s) => s._id);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await TimetableEntry.deleteMany({ institution: institution._id, classSection: { $in: ids } }, { session });
      await TimetableEntry.insertMany(draft.entries.map((e) => ({ institution: institution._id, classSection: e.classSection, teacher: e.teacher, course: e.course, subject: e.subject, dayOfWeek: e.dayOfWeek, startTime: e.startTime, endTime: e.endTime, createdBy: req.user._id })), { session });
    });
  } finally { await session.endSession(); }
  const perTeacher = new Map();
  for (const e of draft.entries) perTeacher.set(String(e.teacher), (perTeacher.get(String(e.teacher)) || 0) + 1);
  await Promise.all([...perTeacher].map(([teacher, n]) => notifyMany([teacher], { title: `${institution.name}: new timetable`, body: `Your weekly timetable was updated: ${n} class${n === 1 ? '' : 'es'} a week. Open My Timetable to see the times.`, sentBy: req.user._id }).catch(() => {})));
  return ok(res, { saved: draft.entries.length, sections: draft.sections.length, unplaced: draft.unplaced }, `Timetable saved: ${draft.entries.length} classes across ${draft.sections.length} section${draft.sections.length === 1 ? '' : 's'}.`);
});

// GET /api/institutions/:id/reports/campuses?from=&to=
const campusReports = asyncHandler(async (req, res) => {
  const institution = await institutionFor(req, 'ops:manage');
  try { return ok(res, await campusReport(institution._id, req.query)); } catch (err) { throw asAppError(err); }
});

// The assistant spends the institution's AI key, so it needs 'ai:use' like the other AI tools.
async function assistantInstitution(req) {
  const institution = await institutionFor(req);
  if (!hasStaffPermission(institution, req.user._id, 'ai:use', 'ai:manage')) throw new AppError('Using the institution assistant needs the owner or the "ai:use" permission.', 403);
  return institution;
}

// POST /api/institutions/:id/assistant/plan { message } — proposes one action with a preview.
const assistantPlan = asyncHandler(async (req, res) => {
  const institution = await assistantInstitution(req);
  try { return ok(res, await assistant.plan(institution, req.user._id, req.body.message)); } catch (err) { throw asAppError(err); }
});

// POST /api/institutions/:id/assistant/execute { action, params } — after the person confirms.
const assistantExecute = asyncHandler(async (req, res) => {
  const institution = await assistantInstitution(req);
  try { return ok(res, await assistant.execute(institution, req.user, req.body.action, req.body.params || {})); } catch (err) { throw asAppError(err); }
});

module.exports = { previewTimetable, applyTimetable, campusReports, assistantPlan, assistantExecute };
