const mongoose = require('mongoose');
const JobApplication = require('../models/JobApplication');
const Employment = require('../models/Employment');
const Institution = require('../models/Institution');
const PrivateFile = require('../models/PrivateFile');
const AppError = require('../utils/AppError');
const jobAccess = require('./jobAccess.service');
const { notify } = require('./notification.service');

// Offer → candidate accepts or declines → offer letter → Joined, plus a message thread on each
// application between the hiring side and the candidate. The offer is kept on the existing
// Employment record (status 'offered' → 'accepted' → 'active' when the candidate joins).
//
// Agent (agreement) jobs: the candidate came through the agent, so the institute makes the offer
// and writes the letter, both go to the agent, and the agent forwards them to the candidate.

const fail = (m, c = 422) => new AppError(m, c);
const CURRENCY = /^[A-Z]{3}$/;
const links = () => require('../utils/dashLinks');

async function loadForManager(appId, user) {
  if (!mongoose.isValidObjectId(appId)) throw fail('Application not found.', 404);
  const application = await JobApplication.findById(appId).populate('job').populate('applicant', 'fullName email');
  if (!application) throw fail('Application not found.', 404);
  await jobAccess.assertCanManageJob(application.job, user);
  return application;
}
// Who makes the offer: the institute on an agent's agreement job, otherwise the job's manager.
async function loadForOffer(appId, user) {
  if (!mongoose.isValidObjectId(appId)) throw fail('Application not found.', 404);
  const application = await JobApplication.findById(appId).populate('job').populate('applicant', 'fullName email');
  if (!application) throw fail('Application not found.', 404);
  if (application.job.agreement) {
    if (!(await jobAccess.isAgreementInstitute(application.job, user))) throw fail('The institute makes the offer for this job. Use "Request offer" to ask the institute.', 403);
  } else await jobAccess.assertCanManageJob(application.job, user);
  return application;
}
// The hiring side to notify: the poster, plus the institute's owner and recruiters.
async function hiringSide(job) {
  const ids = new Set([String(job.postedBy)]);
  if (job.institution) {
    const inst = await Institution.findById(job.institution).select('owner staff');
    if (inst) {
      ids.add(String(inst.owner));
      for (const s of inst.staff || []) if ((s.permissions || []).includes(jobAccess.PERMISSION)) ids.add(String(s.user));
    }
  }
  return [...ids];
}
const tellCandidate = (application, title, body, by) => notify(application.applicant._id || application.applicant, { title, body, sentBy: by, link: links().candidate('applications'), category: 'application' }, { email: true, emailPreference: 'applicationEmails', ctaLabel: 'Open my applications' }).catch(() => {});
const tellAgent = (job, title, body, by) => notify(job.postedBy, { title, body, sentBy: by, link: links().manager(job), category: 'application' }, { email: true, emailPreference: 'applicationEmails' }).catch(() => {});
async function tellInstituteOf(job, title, body, by) {
  const { tellInstitution } = require('./recruitment.service');
  await tellInstitution(job.institution, { title, body, sentBy: by });
}

// POST /api/jobs/applications/:appId/offer
async function makeOffer(user, appId, body = {}) {
  const application = await loadForOffer(appId, user);
  const viaAgent = Boolean(application.job.agreement);
  if (['hired', 'completed', 'rejected', 'withdrawn'].includes(application.status)) throw fail(`This application is already ${application.status}.`, 409);
  const salary = Number(body.salary);
  if (!(salary > 0)) throw fail('Enter the salary you are offering.');
  const currency = String(body.currency || application.job.currency || 'PKR').toUpperCase();
  if (!CURRENCY.test(currency)) throw fail('Choose the salary currency.');
  const period = ['month', 'year', 'hour'].includes(body.salaryPeriod) ? body.salaryPeriod : 'month';
  const startDate = body.startDate ? new Date(body.startDate) : null;
  if (startDate && Number.isNaN(startDate.getTime())) throw fail('Enter a valid joining date.');
  const expiresAt = body.expiresAt ? new Date(`${String(body.expiresAt).slice(0, 10)}T23:59:59.999Z`) : null;
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt < new Date())) throw fail('The reply-by date must be in the future.');
  const terms = String(body.terms || '').trim().slice(0, 3000);

  let employment = await Employment.findOne({ application: application._id });
  if (employment && !['offered', 'declined'].includes(employment.status)) throw fail('The candidate already accepted an offer. Send the offer letter instead.', 409);
  const offer = { salaryPeriod: period, expiresAt, terms, sentBy: user._id, sentAt: new Date(), viaAgent, forwardedAt: null };
  if (!employment) employment = new Employment({ application: application._id, job: application.job._id, employer: application.job.postedBy, employee: application.applicant._id });
  Object.assign(employment, { salary, currency, startDate, status: 'offered', offeredAt: new Date(), respondedAt: null, offer });
  await employment.save();

  if (viaAgent) {
    // Goes to the agent first; the candidate sees it once the agent forwards it.
    application.statusHistory.push({ status: application.status, by: user._id, byRole: 'hiring_organization', note: `Institute offer sent to the agent: ${currency} ${salary.toLocaleString()} per ${period}` });
    await application.save();
    await tellAgent(application.job, `Offer from ${application.job.company}: ${application.applicant.fullName}`, `${currency} ${salary.toLocaleString()} per ${period}. Forward it to the candidate from Manage Candidates.`, user._id);
    return employment;
  }
  const revised = application.status === 'selected';
  application.status = 'selected';
  application.statusHistory.push({ status: 'selected', by: user._id, byRole: 'hiring_organization', note: `${revised ? 'Revised offer' : 'Offer'}: ${currency} ${salary.toLocaleString()} per ${period}` });
  await application.save();
  await tellCandidate(application, `${revised ? 'Revised job offer' : 'Job offer'}: ${application.job.title} @ ${application.job.company}`,
    `${currency} ${salary.toLocaleString()} per ${period}${startDate ? `, joining ${startDate.toDateString()}` : ''}${expiresAt ? `. Please reply by ${expiresAt.toDateString()}` : ''}. Accept or decline it in Jobs & Applications → My Applications.`, user._id);
  return employment;
}

// Candidate's answer to an offer made from the Offer stage (see employment.controller).
async function answerOffer(employment, user, decision) {
  if (employment.offer?.viaAgent && !employment.offer.forwardedAt) throw fail('This offer has not reached you yet.', 409);
  if (employment.offer?.expiresAt && new Date() > employment.offer.expiresAt) throw fail('This offer has expired. Ask the employer to send it again.', 409);
  const application = await JobApplication.findById(employment.application).populate('job');
  employment.respondedAt = new Date();
  employment.status = decision === 'accepted' ? 'accepted' : 'declined';
  await employment.save();
  if (application && application.status === 'selected') {
    application.status = decision === 'accepted' ? 'accepted' : 'withdrawn';
    application.statusHistory.push({ status: application.status, by: user._id, byRole: 'applicant', note: decision === 'accepted' ? 'Candidate accepted the offer' : 'Candidate declined the offer' });
    await application.save();
  }
  if (application?.job) for (const id of await hiringSide(application.job)) {
    const body = decision !== 'accepted' ? '' : application.job.agreement ? 'The candidate accepted. Next: the offer letter (institute) and joining.' : 'You can now send the offer letter from Manage Candidates.';
    await notify(id, { title: `Offer ${decision}: ${user.fullName} · ${application.job.title}`, body, sentBy: user._id, link: links().manager(application.job), category: 'application' }, { email: true, emailPreference: 'applicationEmails' }).catch(() => {});
  }
  return employment;
}

// POST /api/jobs/applications/:appId/offer-letter { text, file? }
async function sendOfferLetter(user, appId, body = {}) {
  const application = await loadForOffer(appId, user);
  const viaAgent = Boolean(application.job.agreement);
  const employment = await Employment.findOne({ application: application._id });
  // Agent jobs: the institute may send the letter together with the offer; it goes to the agent.
  const allowed = viaAgent ? ['offered', 'accepted', 'active'] : ['accepted', 'active'];
  if (!employment || !allowed.includes(employment.status)) throw fail(viaAgent ? 'Make the offer first, then send the offer letter.' : 'Send the offer letter after the candidate accepts the offer.', 409);
  const text = String(body.text || '').trim().slice(0, 12000);
  let file = employment.offerLetter?.file || null;
  if (body.file?.data) {
    const m = /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.file.data));
    if (!m) throw fail('Upload the offer letter as a PDF.');
    const data = Buffer.from(m[1], 'base64');
    if (data.length > 3 * 1024 * 1024) throw fail('The offer letter must be 3 MB or smaller.');
    if (file) await PrivateFile.deleteOne({ _id: file });
    file = (await PrivateFile.create({ purpose: 'offer_letter', owner: user._id, filename: String(body.file.name || 'Offer letter.pdf').replace(/[\\/]/g, '_').slice(0, 160), mimeType: 'application/pdf', size: data.length, data }))._id;
  }
  if (text.length < 50 && !file) throw fail('Write the offer letter (at least a few lines) or upload it as a PDF.');
  employment.offerLetter = { text, file, sentAt: new Date(), sentBy: user._id, issuer: application.job.company, forwardedAt: null };
  await employment.save();
  if (viaAgent) {
    await tellAgent(application.job, `Offer letter from ${application.job.company}: ${application.applicant.fullName}`, 'Forward it to the candidate from Manage Candidates.', user._id);
    return employment;
  }
  await tellCandidate(application, `Offer letter: ${application.job.title} @ ${application.job.company}`, 'Your offer letter is ready to download in Jobs & Applications → My Applications.', user._id);
  return employment;
}
async function offerLetterFile(user, employmentId) {
  if (!mongoose.isValidObjectId(employmentId)) throw fail('Not found.', 404);
  const employment = await Employment.findById(employmentId).populate('job');
  if (!employment?.offerLetter?.file) throw fail('No offer letter file.', 404);
  const isCandidate = String(employment.employee) === String(user._id);
  if (isCandidate && employment.offer?.viaAgent && !employment.offerLetter.forwardedAt) throw fail('No offer letter file.', 404);
  if (!isCandidate && !(await jobAccess.canSeeCandidates(employment.job, user))) throw fail('You cannot open this offer letter.', 403);
  return PrivateFile.findById(employment.offerLetter.file);
}

// ---------------------------------------------------------------- agent jobs
// POST /api/jobs/applications/:appId/request-offer { note } — the agent asks the institute.
async function requestOffer(user, appId, note) {
  if (!mongoose.isValidObjectId(appId)) throw fail('Application not found.', 404);
  const application = await JobApplication.findById(appId).populate('job').populate('applicant', 'fullName');
  if (!application) throw fail('Application not found.', 404);
  if (!application.job.agreement) throw fail('On your own jobs you make the offer yourself.', 409);
  await jobAccess.assertCanManageJob(application.job, user);
  if (!application.institutionSelection?.at) throw fail('The institute has not selected this candidate yet.', 409);
  if (['hired', 'completed', 'rejected', 'withdrawn'].includes(application.status)) throw fail(`This application is already ${application.status}.`, 409);
  const text = String(note || '').trim().slice(0, 1000);
  application.offerRequest = { by: user._id, at: new Date(), note: text };
  application.statusHistory.push({ status: application.status, by: user._id, byRole: 'agent', note: `Offer requested from the institute${text ? `: ${text}` : ''}` });
  await application.save();
  await tellInstituteOf(application.job, `Offer requested: ${application.applicant.fullName} for ${application.job.title}`, text || 'Your recruitment agent recommends this candidate. Make the offer in Jobs & Hiring → Agents → Candidates.', user._id);
  return application;
}
// POST /api/jobs/applications/:appId/forward-offer — the agent passes the institute's offer and/or
// offer letter on to the candidate.
async function forwardOffer(user, appId) {
  if (!mongoose.isValidObjectId(appId)) throw fail('Application not found.', 404);
  const application = await JobApplication.findById(appId).populate('job').populate('applicant', 'fullName email');
  if (!application?.job?.agreement) throw fail('Application not found.', 404);
  await jobAccess.assertCanManageJob(application.job, user);
  const employment = await Employment.findOne({ application: application._id });
  if (!employment?.offer?.sentAt) throw fail('The institute has not sent an offer yet.', 409);
  const sent = [];
  if (!employment.offer.forwardedAt) {
    employment.offer.forwardedAt = new Date();
    const revised = application.status === 'selected';
    application.status = 'selected';
    application.statusHistory.push({ status: 'selected', by: user._id, byRole: 'agent', note: `Agent forwarded the institute's offer: ${employment.currency} ${employment.salary.toLocaleString()} per ${employment.offer.salaryPeriod}` });
    await application.save();
    await tellCandidate(application, `${revised ? 'Revised job offer' : 'Job offer'}: ${application.job.title} @ ${application.job.company}`,
      `${employment.currency} ${employment.salary.toLocaleString()} per ${employment.offer.salaryPeriod}${employment.startDate ? `, joining ${employment.startDate.toDateString()}` : ''}. Accept or decline it in Jobs & Applications → My Applications.`, user._id);
    sent.push('offer');
  }
  if (employment.offerLetter?.sentAt && !employment.offerLetter.forwardedAt) {
    employment.offerLetter.forwardedAt = new Date();
    await tellCandidate(application, `Offer letter: ${application.job.title} @ ${application.job.company}`, 'Your offer letter is ready in Jobs & Applications → My Applications.', user._id);
    sent.push('offer letter');
  }
  if (!sent.length) throw fail('Everything from the institute is already with the candidate.', 409);
  await employment.save();
  await tellInstituteOf(application.job, `Agent sent your ${sent.join(' and ')} to ${application.applicant.fullName}`, application.job.title, user._id);
  return { employment, sent };
}
// What the candidate may see of an offer: nothing the agent has not forwarded yet.
function candidateView(e) {
  if (!e) return e;
  if (e.offer?.viaAgent && !e.offer.forwardedAt) return null;
  if (e.offer?.viaAgent && e.offerLetter?.sentAt && !e.offerLetter.forwardedAt) return { ...e, offerLetter: { ...e.offerLetter, sentAt: null, text: '', file: null } };
  return e;
}

// ---------------------------------------------------------------- application messages
async function threadAccess(appId, user) {
  if (!mongoose.isValidObjectId(appId)) throw fail('Application not found.', 404);
  const application = await JobApplication.findById(appId).populate('job').populate('applicant', 'fullName');
  if (!application) throw fail('Application not found.', 404);
  if (String(application.applicant._id) === String(user._id)) return { application, side: 'candidate' };
  await jobAccess.assertCanManageJob(application.job, user);
  return { application, side: 'employer' };
}
async function messages(user, appId) {
  const { application, side } = await threadAccess(appId, user);
  return { side, job: { _id: application.job._id, title: application.job.title, company: application.job.company }, candidate: application.applicant.fullName, messages: application.messages || [] };
}
async function postMessage(user, appId, text) {
  const { application, side } = await threadAccess(appId, user);
  const body = String(text || '').trim().slice(0, 3000);
  if (!body) throw fail('Write a message.');
  if (side === 'candidate' && application.status === 'withdrawn') throw fail('You withdrew this application.', 409);
  application.messages.push({ by: user._id, side, name: side === 'candidate' ? application.applicant.fullName : application.job.company, text: body });
  await application.save();
  const title = side === 'candidate' ? `Message from ${application.applicant.fullName}: ${application.job.title}` : `Message from ${application.job.company}: ${application.job.title}`;
  // On an agent's job the candidate talks to the agent, not the institute.
  const targets = side === 'candidate' ? (application.job.agreement ? [String(application.job.postedBy)] : await hiringSide(application.job)) : [String(application.applicant._id)];
  for (const id of targets) await notify(id, { title, body: body.slice(0, 300), sentBy: user._id, link: side === 'candidate' ? links().manager(application.job) : links().candidate('applications'), category: 'application' }, { email: true, emailPreference: 'applicationEmails' }).catch(() => {});
  return application.messages;
}

module.exports = { makeOffer, answerOffer, sendOfferLetter, offerLetterFile, messages, postMessage, requestOffer, forwardOffer, candidateView, hiringSide, loadForManager };
