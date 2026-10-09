const LiveClassSession = require('../models/LiveClassSession');

// Ties Advanced Class Control (the socket-driven slide/energy/poll classroom) to the scheduled
// LiveClassSession of the same course, so one class has ONE lifecycle: starting class control
// starts the scheduled class, students joining it are marked present on that session, and ending
// it stores the engagement summary on the session and ends it (producing its attendance records).

const EARLY_START_MS = 15 * 60 * 1000;

// Finds (and if needed starts) the teacher's scheduled class for this course happening now.
async function linkLiveSession({ courseId, teacherId, requestedId = null, now = new Date() }) {
  const filter = { course: courseId, teacher: teacherId, status: { $in: ['scheduled', 'live'] } };
  let session = null;
  if (requestedId) session = await LiveClassSession.findOne({ ...filter, _id: requestedId });
  if (!session) {
    session = await LiveClassSession.findOne({
      ...filter,
      $or: [{ status: 'live' }, { scheduledStart: { $lte: new Date(now.getTime() + EARLY_START_MS) }, scheduledEnd: { $gte: now } }]
    }).sort({ status: 1, scheduledStart: 1 }); // 'live' sorts before 'scheduled'
  }
  if (!session) return null;
  if (session.status === 'scheduled') {
    await LiveClassSession.updateOne({ _id: session._id, status: 'scheduled' }, { $set: { status: 'live', startedAt: now, startedByClassControl: true } });
  }
  return String(session._id);
}

// A student joining the class-control room is present on the linked session (late after 15 min).
async function recordJoin(liveSessionId, studentId, now = new Date()) {
  const session = await LiveClassSession.findById(liveSessionId).select('scheduledStart status');
  if (!session || session.status !== 'live') return;
  await LiveClassSession.updateOne(
    { _id: liveSessionId, status: 'live', 'participants.student': { $ne: studentId } },
    { $push: { participants: { student: studentId, joinedAt: now, attendanceStatus: now > new Date(session.scheduledStart.getTime() + EARLY_START_MS) ? 'late' : 'present' } } }
  );
}

// Class control ended: keep its engagement on the session; end the session if class control started it.
async function finish(liveSessionId, teacherId, engagement) {
  const session = await LiveClassSession.findByIdAndUpdate(liveSessionId, { $set: { engagement } }, { new: true });
  if (!session || session.status !== 'live' || !session.startedByClassControl) return session;
  const { end } = require('../controllers/liveClass.controller');
  await new Promise((resolve) => {
    const res = { status() { return this; }, json() { resolve(); return this; } };
    end({ params: { id: liveSessionId }, user: { _id: teacherId } }, res, () => resolve());
  });
  return LiveClassSession.findById(liveSessionId);
}

module.exports = { linkLiveSession, recordJoin, finish };
