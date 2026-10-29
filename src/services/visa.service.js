const mongoose = require('mongoose');
const CountryRule = require('../models/CountryRule');
const VisaCase = require('../models/VisaCase');
const JobApplication = require('../models/JobApplication');
const User = require('../models/User');
const PrivateFile = require('../models/PrivateFile');
const AppError = require('../utils/AppError');
const { isRoleVerified } = require('../utils/roleVerification');
const { notify } = require('./notification.service');

// Master 13.7 Visa & Recruitment Support Center. CareerZ is never a visa agency: it shows each
// country's rules, lists verified visa consultants, tracks a candidate's visa case and offers an
// AI assistant that only gives information. Government visa fees are paid on government portals.

const fail = (message, status = 422) => new AppError(message, status);
const oid = (id) => mongoose.isValidObjectId(id);
const { STAGES } = VisaCase;
const STAGE_LABEL = { documents_submitted: 'Documents submitted', employer_verified: 'Employer verified', agency_verified: 'Agency verified', interview_completed: 'Interview completed', offer_letter_received: 'Offer letter received', visa_processing: 'Visa processing', visa_approved: 'Visa approved', travel_completed: 'Travel completed' };
const TEXT_FIELDS = ['workPermit', 'visaRules', 'immigrationRules', 'laborLaws', 'salaryStandards', 'contractRules', 'workingHours', 'ageRequirements'];
const isStaff = (u) => (u?.roles || []).some((r) => ['admin', 'super_admin', 'platform_staff'].includes(r));

// ---------------------------------------------------------------- country rules (admin keeps them)
async function listRules() { return CountryRule.find({ published: true }).sort({ name: 1 }).lean(); }
async function getRule(code) {
  const r = await CountryRule.findOne({ country: String(code || '').toUpperCase(), published: true }).lean();
  if (!r) throw fail('No rules saved for this country yet.', 404);
  return r;
}
async function saveRule(admin, body = {}) {
  const country = String(body.country || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw fail('Enter the 2-letter country code, e.g. AE.');
  const name = String(body.name || '').trim().slice(0, 80);
  if (name.length < 2) throw fail('Enter the country name.');
  const doc = { country, name, published: body.published !== false, updatedBy: admin._id };
  for (const f of TEXT_FIELDS) doc[f] = String(body[f] || '').trim().slice(0, 4000);
  doc.visaTypes = [].concat(body.visaTypes || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
  doc.requiredDocuments = [].concat(body.requiredDocuments || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 40);
  doc.officialLinks = [].concat(body.officialLinks || []).filter((l) => l && /^https:\/\//.test(l.url || '')).slice(0, 10).map((l) => ({ label: String(l.label || l.url).slice(0, 80), url: String(l.url).slice(0, 300) }));
  return CountryRule.findOneAndUpdate({ country }, { $set: doc }, { upsert: true, new: true });
}
async function deleteRule(code) { await CountryRule.deleteOne({ country: String(code || '').toUpperCase() }); return { deleted: true }; }

// ---------------------------------------------------------------- verified visa consultants
// An agent (agency subtype) with a recruitment / consultancy licence that a CareerZ admin checked.
async function setConsultant(admin, userId, { verified, licenseNo, countries, note } = {}) {
  if (!oid(userId)) throw fail('Agent not found.', 404);
  const u = await User.findOne({ _id: userId, roles: 'education_agent' });
  if (!u) throw fail('Agent not found.', 404);
  if (verified) {
    const lic = String(licenseNo || '').trim().slice(0, 60);
    if (lic.length < 3) throw fail('Enter the government licence / registration number you checked.');
    u.visaConsultant = { verified: true, licenseNo: lic, countries: [].concat(countries || []).map((c) => String(c).toUpperCase().slice(0, 2)).filter(Boolean).slice(0, 30), note: String(note || '').slice(0, 300), verifiedAt: new Date(), verifiedBy: admin._id };
  } else u.visaConsultant = { verified: false, licenseNo: u.visaConsultant?.licenseNo || '', countries: [], note: String(note || '').slice(0, 300), verifiedAt: null, verifiedBy: admin._id };
  u.markModified('visaConsultant');
  await u.save();
  await notify(u._id, { title: verified ? 'You are a CareerZ verified visa consultant' : 'Your visa consultant badge was removed', body: note || '', category: 'visa' }).catch(() => {});
  return u.visaConsultant;
}
async function adminAgents(q) {
  const filter = { roles: 'education_agent' };
  const s = String(q || '').trim().slice(0, 80);
  if (s) { const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); filter.$or = [{ fullName: re }, { email: re }]; }
  return User.find(filter).select('fullName email city visaConsultant').sort({ createdAt: -1 }).limit(50).lean();
}
async function consultants(country) {
  const filter = { 'visaConsultant.verified': true, status: 'active' };
  if (country) filter['visaConsultant.countries'] = String(country).toUpperCase();
  return (await User.find(filter).select('fullName city country visaConsultant.countries visaConsultant.licenseNo visaConsultant.verifiedAt').lean()).map((u) => ({ _id: u._id, fullName: u.fullName, city: u.city, country: u.country, countries: u.visaConsultant?.countries || [], licenseNo: u.visaConsultant?.licenseNo, verifiedAt: u.visaConsultant?.verifiedAt }));
}

// ---------------------------------------------------------------- visa cases
async function canHire(user, job) {
  return require('./jobAccess.service').canManageJob(job, user, 'manage_applicants');
}
async function caseFor(user, id) {
  if (!oid(id)) throw fail('Visa case not found.', 404);
  const c = await VisaCase.findById(id).populate('job', 'title company country postedBy institution agreement').populate('candidate', 'fullName email phone').populate('consultant', 'fullName');
  if (!c) throw fail('Visa case not found.', 404);
  const side = String(c.candidate._id) === String(user._id) ? 'candidate' : String(c.consultant?._id) === String(user._id) ? 'consultant' : (await canHire(user, c.job)) ? 'hiring' : isStaff(user) ? 'admin' : null;
  if (!side) throw fail('Visa case not found.', 404);
  return { c, side };
}

// The hiring side opens a case for a selected/hired candidate on a job abroad (or visa sponsored).
async function openCase(user, applicationId, { visaType } = {}) {
  if (!oid(applicationId)) throw fail('Application not found.', 404);
  const app = await JobApplication.findById(applicationId).populate('job');
  if (!app) throw fail('Application not found.', 404);
  if (!(await canHire(user, app.job))) throw fail('Only the hiring side of this job can open a visa case.', 403);
  const candidate = await User.findById(app.applicant).select('country fullName');
  const abroad = app.job.visaSponsorship || (candidate?.country && app.job.country && String(candidate.country).toUpperCase() !== String(app.job.country).toUpperCase());
  if (!abroad) throw fail('A visa case is only for a job in another country or with visa sponsorship.', 409);
  if (!['interview', 'final_interview', 'selected', 'accepted', 'hired'].includes(app.status)) throw fail('Open the visa case once the candidate is at interview or selected.', 409);
  if (await VisaCase.exists({ application: app._id })) throw fail('A visa case already exists for this application.', 409);
  const employerVerified = await isRoleVerified(app.job.postedBy, 'employer') || await isRoleVerified(app.job.postedBy, 'education_agent');
  const c = await VisaCase.create({
    candidate: app.applicant, application: app._id, job: app.job._id, hiringSide: user._id, destination: String(app.job.country).toUpperCase(), visaType: String(visaType || '').slice(0, 60),
    stages: STAGES.map((key) => ({ key, done: key === 'employer_verified' ? employerVerified : key === 'interview_completed' ? ['selected', 'accepted', 'hired'].includes(app.status) : false, at: null })),
    history: [{ text: 'Visa case opened', by: user._id }]
  });
  c.stages.forEach((s) => { if (s.done) { s.at = new Date(); s.by = null; s.note = 'Checked by CareerZ'; } });
  await c.save();
  await notify(app.applicant, { title: `Visa case opened: ${app.job.title} (${c.destination})`, body: 'Upload your documents and follow every step in Jobs → Visa cases.', link: '/dashboard?tab=jobs&sub=visa', category: 'visa' }, { email: true }).catch(() => {});
  return c;
}

async function setStage(user, id, { key, done, note }) {
  const { c, side } = await caseFor(user, id);
  if (!['hiring', 'consultant', 'admin'].includes(side)) throw fail('Only the employer, agent or the visa consultant updates the steps.', 403);
  if (!STAGES.includes(key)) throw fail('Choose a step.');
  if (!['active', 'approved'].includes(c.status)) throw fail('This visa case is closed.', 409);
  if (key === 'agency_verified' && done && !(side === 'consultant' || side === 'admin' || c.consultant)) throw fail('Assign a verified visa consultant first.', 409);
  const s = c.stages.find((x) => x.key === key);
  s.done = Boolean(done);
  s.at = s.done ? new Date() : null;
  s.by = user._id;
  s.note = String(note || '').trim().slice(0, 300);
  if (key === 'visa_approved' && s.done) c.status = 'active';
  c.history.push({ text: `${STAGE_LABEL[key]}: ${s.done ? 'done' : 'not done'}${s.note ? ` (${s.note})` : ''}`, by: user._id });
  await c.save();
  await notify(c.candidate._id, { title: `Visa case ${c.job.title}: ${STAGE_LABEL[key]}${s.done ? ' ✓' : ''}`, body: s.note, link: '/dashboard?tab=jobs&sub=visa', category: 'visa' }, { email: s.done }).catch(() => {});
  return c;
}

async function setOutcome(user, id, { status, note }) {
  const { c, side } = await caseFor(user, id);
  if (!['hiring', 'consultant', 'admin'].includes(side)) throw fail('Only the hiring side or the consultant closes the case.', 403);
  if (!['approved', 'refused', 'closed', 'active'].includes(status)) throw fail('Choose approved, refused, closed or active.');
  c.status = status;
  if (status === 'approved') { const s = c.stages.find((x) => x.key === 'visa_approved'); if (!s.done) Object.assign(s, { done: true, at: new Date(), by: user._id }); }
  c.history.push({ text: `Case ${status}${note ? `: ${String(note).slice(0, 300)}` : ''}`, by: user._id });
  await c.save();
  await notify(c.candidate._id, { title: `Visa case ${c.job.title}: ${status === 'approved' ? 'visa approved' : status === 'refused' ? 'visa refused' : status}`, body: note || '', category: 'visa' }, { email: true }).catch(() => {});
  return c;
}

async function assignConsultant(user, id, consultantId) {
  const { c, side } = await caseFor(user, id);
  if (!['hiring', 'admin', 'candidate'].includes(side)) throw fail('Not allowed.', 403);
  if (!consultantId) { c.consultant = null; c.history.push({ text: 'Consultant removed', by: user._id }); await c.save(); return c; }
  if (!oid(consultantId) || !(await User.exists({ _id: consultantId, 'visaConsultant.verified': true, status: 'active' }))) throw fail('Choose a CareerZ verified visa consultant.');
  c.consultant = consultantId;
  c.history.push({ text: 'Verified visa consultant assigned', by: user._id });
  await c.save();
  await notify(consultantId, { title: `New visa case: ${c.candidate.fullName} → ${c.destination}`, link: '/dashboard?ws=education_agent&tab=visaCases', category: 'visa' }).catch(() => {});
  return c;
}

async function addDocument(user, id, { name, file }) {
  const { c, side } = await caseFor(user, id);
  if (!['candidate', 'consultant', 'hiring'].includes(side)) throw fail('Not allowed.', 403);
  const m = /^data:(application\/pdf|image\/(png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(file?.data || ''));
  if (!m) throw fail('Upload a PDF, PNG, JPG or WEBP file.');
  const data = Buffer.from(m[3], 'base64');
  if (data.length > 5 * 1024 * 1024) throw fail('Each document must be 5 MB or smaller.');
  const label = String(name || '').trim().slice(0, 80);
  if (label.length < 2) throw fail('Name the document, e.g. Passport.');
  const pf = await PrivateFile.create({ purpose: 'visa_document', owner: user._id, filename: String(file.name || 'document').slice(0, 160), mimeType: m[1], size: data.length, data });
  c.documents.push({ name: label, file: pf._id, by: user._id });
  if (side === 'candidate') { const s = c.stages.find((x) => x.key === 'documents_submitted'); if (!s.done) Object.assign(s, { done: true, at: new Date(), by: user._id, note: 'First document uploaded' }); }
  c.history.push({ text: `Document added: ${label}`, by: user._id });
  await c.save();
  if (side === 'candidate') { await notify(c.hiringSide, { title: `${c.candidate.fullName} uploaded ${label} (visa case)`, category: 'visa' }).catch(() => {}); if (c.consultant) await notify(c.consultant._id, { title: `${c.candidate.fullName} uploaded ${label}`, category: 'visa' }).catch(() => {}); }
  return c;
}
async function documentFile(user, id, index) {
  const { c } = await caseFor(user, id);
  const d = c.documents[Number(index)];
  const f = d ? await PrivateFile.findById(d.file) : null;
  if (!f) throw fail('Document not found.', 404);
  return f;
}

async function myCases(user) {
  return VisaCase.find({ $or: [{ candidate: user._id }, { hiringSide: user._id }, { consultant: user._id }] }).populate('job', 'title company country').populate('candidate', 'fullName email').populate('consultant', 'fullName').sort({ updatedAt: -1 }).lean();
}
async function adminCases() {
  return VisaCase.find().populate('job', 'title company country').populate('candidate', 'fullName email').populate('hiringSide', 'fullName').populate('consultant', 'fullName').sort({ updatedAt: -1 }).limit(300).lean();
}

// ---------------------------------------------------------------- AI visa assistant (information only)
async function ask(user, { country, question } = {}) {
  const q = String(question || '').trim().slice(0, 1000);
  if (q.length < 5) throw fail('Write your question.');
  const rule = country ? await CountryRule.findOne({ country: String(country).toUpperCase(), published: true }).lean() : null;
  const facts = rule ? JSON.stringify({ country: rule.name, visaTypes: rule.visaTypes, requiredDocuments: rule.requiredDocuments, ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, rule[f]])), officialLinks: rule.officialLinks }).slice(0, 12000) : 'No CareerZ notes saved for this country.';
  const answer = await require('./ai.service').generate(user._id,
    'You are the CareerZ Visa Assistant. You ONLY give general information: required documents, eligibility, visa types, government procedures and work-permit guidance. You never approve, guarantee or promise a visa, never ask for money, and you always tell the person that only the government of that country decides and that government visa fees are paid on the official government portal, not to CareerZ. Use the CareerZ notes when given; say clearly when something must be checked on the official website. Plain text.',
    `CareerZ notes: ${facts}\n\nQuestion: ${q}`);
  return { answer: String(answer || '').trim(), country: rule?.name || null, disclaimer: 'CareerZ is a technology platform only. Visa and immigration decisions are made only by the government concerned.' };
}

module.exports = { adminAgents, STAGES, STAGE_LABEL, listRules, getRule, saveRule, deleteRule, setConsultant, consultants, openCase, setStage, setOutcome, assignConsultant, addDocument, documentFile, myCases, adminCases, ask, caseFor };
