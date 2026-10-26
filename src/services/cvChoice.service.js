const mongoose = require('mongoose');
const Resume = require('../models/Resume');
const ResumeVariant = require('../models/ResumeVariant');
const PrivateFile = require('../models/PrivateFile');
const JobApplication = require('../models/JobApplication');
const AppError = require('../utils/AppError');

// The student's uploaded CV file (PDF/Word, private) and the choice of which CV goes with an
// application: the main builder CV, one of the CV Versions, or the uploaded file.
//
// An application keeps a reference to the uploaded file it was sent with. Replacing or removing
// the CV later only deletes the old file when no application points at it, so employers can
// always open exactly what was sent.

const CV_TYPES = { 'application/pdf': 'pdf', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' };
const MAX = 2 * 1024 * 1024;
const fail = (m, c = 422) => new AppError(m, c);

async function dropIfUnused(fileId) {
  if (!fileId) return;
  if (await JobApplication.exists({ 'resumeSnapshot.cvFile': fileId })) return;
  await PrivateFile.deleteOne({ _id: fileId });
}

async function upload(userId, { name, data } = {}) {
  const m = /^data:([\w./+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
  if (!m || !CV_TYPES[m[1]]) throw fail('Upload your CV as a PDF or Word file.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX) throw fail('The CV must be 2 MB or smaller.');
  const filename = String(name || `cv.${CV_TYPES[m[1]]}`).replace(/[\\/]/g, '_').slice(0, 160);
  const file = await PrivateFile.create({ purpose: 'resume_cv', owner: userId, filename, mimeType: m[1], size: buf.length, data: buf });
  const before = await Resume.findOne({ user: userId }).select('cvFile');
  const resume = await Resume.findOneAndUpdate({ user: userId }, { $set: { cvFile: file._id, cvFileName: filename } }, { new: true, upsert: true });
  await dropIfUnused(before?.cvFile);
  return resume;
}
async function remove(userId) {
  const before = await Resume.findOne({ user: userId }).select('cvFile');
  const resume = await Resume.findOneAndUpdate({ user: userId }, { $set: { cvFile: null, cvFileName: '' } }, { new: true, upsert: true });
  await dropIfUnused(before?.cvFile);
  return resume;
}

// Snapshot stored on the application for the chosen CV. `choice`: undefined/'default' (the
// default CV Version if there is one, else the main CV), 'main', 'file', or a CV Version id.
async function snapshotFor(userId, choice) {
  const resume = await Resume.findOne({ user: userId });
  const main = resume ? resume.toObject() : null;
  if (choice === 'file') {
    if (!resume?.cvFile) throw fail('Upload a CV file first, or choose another CV.');
    return { ...main, cvSource: 'file' };
  }
  if (choice === 'main') return main ? { ...main, cvFile: null, cvFileName: '', cvSource: 'main' } : null;
  let variant = null;
  if (choice && choice !== 'default') {
    if (!mongoose.isValidObjectId(choice)) throw fail('Choose one of your CVs.');
    variant = await ResumeVariant.findOne({ _id: choice, user: userId }).lean();
    if (!variant) throw fail('That CV was not found among your CV Versions.', 403);
  } else {
    variant = await ResumeVariant.findOne({ user: userId, isDefault: true }).lean();
    if (!variant) return main; // unchanged behaviour: the main CV (with its file, if any)
  }
  const { _id, user, name, targetRole, job, isDefault, createdAt, updatedAt, __v, ...content } = variant; // eslint-disable-line no-unused-vars
  return { ...content, user: userId, linkedinUrl: main?.linkedinUrl || '', experienceLevel: main?.experienceLevel || '', cvFile: null, cvFileName: '', cvSource: 'variant', variantName: name };
}

module.exports = { upload, remove, snapshotFor, CV_TYPES };
