const mongoose = require('mongoose');
const Interview = require('../models/Interview');
const AppError = require('../utils/AppError');
const jobAccess = require('./jobAccess.service');

// Online job interviews run in CareerZ's own video room (the same WebRTC system as live classes
// and parent–teacher meetings), never on an outside meeting service. Only the candidate and the
// people who manage the job may join, from 15 minutes before the start until 4 hours after.

const EARLY_MS = 15 * 60 * 1000;
const LATE_MS = 4 * 60 * 60 * 1000;

async function access(interviewId, userId) {
  if (!mongoose.isValidObjectId(interviewId)) throw new AppError('Interview not found.', 404);
  const interview = await Interview.findById(interviewId).populate('job', 'title company postedBy institution agreement');
  if (!interview) throw new AppError('Interview not found.', 404);
  const isCandidate = String(interview.candidate) === String(userId);
  const host = !isCandidate && (String(interview.scheduledBy) === String(userId) || (await jobAccess.canSeeCandidates(interview.job, { _id: userId })));
  if (!isCandidate && !host) throw new AppError('You are not part of this interview.', 403);
  if (interview.mode !== 'online') throw new AppError('This interview is in person.', 409);
  if (interview.provider && interview.provider !== 'careerz') throw new AppError('This interview is on an outside meeting service. Use its meeting link.', 409);
  if (interview.status !== 'scheduled') throw new AppError(`This interview was ${interview.status}.`, 409);
  const start = new Date(interview.scheduledDate).getTime(), now = Date.now();
  if (now < start - EARLY_MS) throw new AppError(`The interview room opens 15 minutes before the start (${new Date(start).toLocaleString()}).`, 409);
  if (now > start + LATE_MS) throw new AppError('This interview time has passed. Reschedule it if needed.', 409);
  return { interview, host };
}

// STUN/TURN servers for the browser, same settings as live classes.
function iceServers(userId) {
  const list = [{ urls: process.env.RTC_STUN_URL || 'stun:stun.l.google.com:19302' }];
  if (process.env.RTC_TURN_URLS) {
    let username = process.env.RTC_TURN_USERNAME, credential = process.env.RTC_TURN_CREDENTIAL;
    if (process.env.RTC_TURN_SHARED_SECRET) {
      username = `${Math.floor(Date.now() / 1000 + 3600)}:${userId}`;
      credential = require('crypto').createHmac('sha1', process.env.RTC_TURN_SHARED_SECRET).update(username).digest('base64');
    }
    if (username && credential) list.push({ urls: process.env.RTC_TURN_URLS.split(',').map((v) => v.trim()), username, credential });
  }
  return list;
}

function link(interviewId) {
  return `${require('../utils/siteUrl').siteUrl()}/dashboard?interview=${interviewId}`;
}

module.exports = { access, iceServers, link };
