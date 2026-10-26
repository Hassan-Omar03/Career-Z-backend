// Private video rooms on the built-in WebRTC system (not live classes): parent–teacher meetings
// ("ptm:<id>") and online job interviews ("interview:<id>"). Returns the joiner's role or throws.
const isPrivateRoom = (sessionId) => /^(ptm|interview):/.test(String(sessionId));

async function access(sessionId, userId) {
  const [kind, id] = String(sessionId).split(':');
  if (kind === 'ptm') {
    const meeting = await require('../services/ptmVideo.service').access(id, userId);
    return { role: String(meeting.teacher) === String(userId) ? 'teacher' : 'parent' };
  }
  if (kind === 'interview') {
    const { host } = await require('../services/interviewVideo.service').access(id, userId);
    return { role: host ? 'teacher' : 'student' };
  }
  throw new Error('Unknown meeting room.');
}

module.exports = { isPrivateRoom, access };
