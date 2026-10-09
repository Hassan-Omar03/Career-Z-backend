const Institution = require('../models/Institution');
const InstitutionSettings = require('../models/InstitutionSettings');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');
const { assertOwnerOrPermission } = require('./staffPermission.controller');

const RESERVED_SUBDOMAINS = new Set(['www', 'api', 'admin', 'app', 'mail', 'careerz', 'dashboard', 'static', 'cdn', 'support', 'help']);

async function settingsFor(institutionId) {
  const doc = await InstitutionSettings.findOne({ institution: institutionId }).lean();
  return doc || new InstitutionSettings({ institution: institutionId }).toObject();
}

function publicView(settings, institution) {
  return {
    institution: institution ? { _id: institution._id, name: institution.name, logo: institution.logo, slug: institution.slug } : undefined,
    branding: settings.branding,
    pages: (settings.pages || []).filter((p) => p.published).map(({ slug, title }) => ({ slug, title })),
    subdomain: settings.subdomain || null,
    timezone: settings.timezone,
    workingDays: settings.workingDays,
    schoolHours: settings.schoolHours,
    classroom: { recordingPolicy: settings.classroom?.recordingPolicy, requireStudentConsent: settings.classroom?.requireStudentConsent }
  };
}

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// GET /api/institutions/:id/settings — full settings for managers, public view for others.
const getSettings = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id).select('name logo slug owner staff');
  if (!institution) throw new AppError('Institution not found.', 404);
  const settings = await settingsFor(institution._id);
  const uid = req.user?._id?.toString();
  const manager = uid && (institution.owner.toString() === uid || institution.staff.some((s) => s.user.toString() === uid));
  return ok(res, manager ? settings : publicView(settings, institution));
});

// PUT /api/institutions/:id/settings — owner, or staff with 'settings:manage'. Partial updates.
const saveSettings = asyncHandler(async (req, res) => {
  const institution = await Institution.findById(req.params.id);
  if (!institution) throw new AppError('Institution not found.', 404);
  assertOwnerOrPermission(institution, req.user._id, 'settings:manage');
  const b = req.body || {};
  const set = { updatedBy: req.user._id };
  if (b.classroom) {
    if (b.classroom.recordingPolicy !== undefined) {
      if (!['disabled', 'teacher_choice', 'always_allowed'].includes(b.classroom.recordingPolicy)) throw new AppError('Invalid recording policy.', 422);
      set['classroom.recordingPolicy'] = b.classroom.recordingPolicy;
    }
    if (b.classroom.requireStudentConsent !== undefined) set['classroom.requireStudentConsent'] = Boolean(b.classroom.requireStudentConsent);
    if (b.classroom.recordingRetentionDays !== undefined) set['classroom.recordingRetentionDays'] = Math.max(0, Math.min(3650, Number(b.classroom.recordingRetentionDays) || 0));
  }
  if (b.branding) {
    for (const key of ['primaryColor', 'accentColor']) if (b.branding[key] !== undefined) {
      if (b.branding[key] && !/^#[0-9a-fA-F]{6}$/.test(b.branding[key])) throw new AppError(`${key} must be a #RRGGBB colour.`, 422);
      set[`branding.${key}`] = b.branding[key] || '';
    }
    if (b.branding.bannerUrl !== undefined) {
      if (b.branding.bannerUrl && !/^https:\/\//.test(b.branding.bannerUrl)) throw new AppError('Banner must be an https:// URL.', 422);
      set['branding.bannerUrl'] = b.branding.bannerUrl || '';
    }
    if (b.branding.tagline !== undefined) set['branding.tagline'] = String(b.branding.tagline).slice(0, 200);
  }
  if (b.pages !== undefined) {
    if (!Array.isArray(b.pages) || b.pages.length > 20) throw new AppError('Up to 20 pages.', 422);
    const slugs = new Set();
    set.pages = b.pages.map((p) => {
      const slug = String(p.slug || '').toLowerCase().trim();
      if (!/^[a-z0-9-]{1,60}$/.test(slug)) throw new AppError(`Page "${p.title || slug}": use lowercase letters, numbers and dashes for the address.`, 422);
      if (slugs.has(slug)) throw new AppError(`Two pages use the address "${slug}".`, 422);
      slugs.add(slug);
      if (!String(p.title || '').trim()) throw new AppError('Every page needs a title.', 422);
      return { slug, title: String(p.title).trim().slice(0, 150), body: String(p.body || '').slice(0, 20000), published: Boolean(p.published) };
    });
  }
  if (b.subdomain !== undefined) {
    const sub = String(b.subdomain || '').toLowerCase().trim();
    if (sub) {
      if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(sub)) throw new AppError('Subdomain: 3-32 lowercase letters, numbers or dashes.', 422);
      if (RESERVED_SUBDOMAINS.has(sub)) throw new AppError('That subdomain is reserved.', 422);
      if (await InstitutionSettings.exists({ subdomain: sub, institution: { $ne: institution._id } })) throw new AppError('That subdomain is already taken.', 409);
      set.subdomain = sub;
    }
  }
  if (b.timezone !== undefined) {
    if (!validTimezone(b.timezone)) throw new AppError('Unknown timezone (use e.g. Asia/Karachi).', 422);
    set.timezone = b.timezone;
  }
  if (b.workingDays !== undefined) {
    const days = [...new Set((Array.isArray(b.workingDays) ? b.workingDays : []).map(Number))].sort();
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new AppError('Pick at least one working day (0 = Sunday ... 6 = Saturday).', 422);
    set.workingDays = days;
  }
  if (b.schoolHours) {
    const re = /^([01]\d|2[0-3]):[0-5]\d$/;
    const start = b.schoolHours.start ?? undefined, end = b.schoolHours.end ?? undefined;
    if ((start && !re.test(start)) || (end && !re.test(end))) throw new AppError('School hours must be HH:MM.', 422);
    if (start && end && start >= end) throw new AppError('School day must end after it starts.', 422);
    if (start) set['schoolHours.start'] = start;
    if (end) set['schoolHours.end'] = end;
  }
  const unset = b.subdomain === '' || b.subdomain === null ? { subdomain: 1 } : undefined;
  await InstitutionSettings.findOneAndUpdate({ institution: institution._id }, { $set: set, ...(unset ? { $unset: unset } : {}) }, { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true });
  return ok(res, await settingsFor(institution._id), 'Institution settings saved.');
});

// GET /api/institutions/by-subdomain/:subdomain — public: resolves gcuf.careerz.pk to its institution.
const bySubdomain = asyncHandler(async (req, res) => {
  const settings = await InstitutionSettings.findOne({ subdomain: String(req.params.subdomain).toLowerCase() }).lean();
  if (!settings) throw new AppError('No institution uses this address.', 404);
  const institution = await Institution.findById(settings.institution).select('name logo slug');
  return ok(res, publicView(settings, institution));
});

// GET /api/institutions/:id/pages/:slug — public page (published only).
const getPage = asyncHandler(async (req, res) => {
  const settings = await InstitutionSettings.findOne({ institution: req.params.id }).lean();
  const page = settings?.pages?.find((p) => p.slug === req.params.slug && p.published);
  if (!page) throw new AppError('Page not found.', 404);
  return ok(res, page);
});

module.exports = { getSettings, saveSettings, bySubdomain, getPage, settingsFor };
