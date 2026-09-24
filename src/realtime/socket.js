const { Server } = require('socket.io');
const env = require('../config/env');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const TimetableEntry = require('../models/TimetableEntry');
const { getBlockingInstitutionFee } = require('../utils/feeAccess');
const crypto = require('crypto');

let io = null;
// Live classrooms are deliberately ephemeral. The durable deck remains a Lesson/Class Resource;
// this map only represents the currently-running teaching session and is discarded on restart.
const liveClasses = new Map();

function publicSession(session) {
  return {
    id: session.id, courseId: session.courseId, courseTitle: session.courseTitle, teacherName: session.teacherName,
    currentSlide: session.currentSlide, meetingLink: session.meetingLink, startedAt: session.startedAt,
    participants: Array.from(session.participants.values()),
    raisedHands: Array.from(session.raisedHands.values())
  };
}

// Same rule as the notification fix in course.controller.js: a student whose enrollment already
// flipped to 'completed' (via the weighted completion engine) is still a real, current member of
// the course — e.g. attending a live revision session after finishing — and must not be treated
// as unenrolled. Only 'dropped' actually means they're no longer part of the course.
async function authorizeStudent(userId, course) {
  const enrollment = await Enrollment.findOne({ student: userId, course: course._id, status: { $ne: 'dropped' } });
  if (!enrollment) throw new Error('You are not enrolled in this course.');
  if (course.institution && await getBlockingInstitutionFee(userId, course.institution)) throw new Error('A due fee is blocking live-class access.');
}

// Simple fixed-window rate limit — a live class is a handful of humans typing, not a firehose;
// this only needs to stop accidental double-submit storms or a scripted abuse attempt, not
// legitimate fast typers. Keyed per (socket, sessionId) so one chatty class can't affect another.
const rateBuckets = new Map();
function tooFast(key, limit, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart > windowMs) {
    rateBuckets.set(key, { windowStart: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
function safeColor(value, fallback) {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback;
}

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.clientUrl.split(',').map((origin) => origin.trim().replace(/\/+$/, '')), credentials: true }
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.accessToken;
      if (typeof token !== 'string') throw new Error('Missing access token');
      const payload = jwt.verify(token, env.jwt.accessSecret, { algorithms: ['HS256'] });
      const user = await User.findById(payload.sub).select('_id status');
      if (!user || user.status !== 'active') throw new Error('Inactive account');
      socket.data.userId = user._id.toString();
      socket.data.expiresAt = payload.exp * 1000;
      if (!Number.isFinite(socket.data.expiresAt)) throw new Error('Missing expiry');
      next();
    } catch {
      next(new Error('Authentication required.'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.expiresAt - Date.now()));
    expiryTimer.unref?.();
    socket.data.liveSessionIds = new Set();

    socket.on('class:start', async (payload = {}, reply = () => {}) => {
      try {
        const course = await Course.findById(payload.courseId).populate('teacher', 'fullName');
        if (!course || String(course.teacher._id) !== socket.data.userId) throw new Error('Only the course teacher can start this class.');
        if (!Array.isArray(payload.slides) || payload.slides.length < 1 || payload.slides.length > 50) throw new Error('A live class needs 1–50 slides.');
        for (const existing of liveClasses.values()) {
          if (existing.teacherId === socket.data.userId) {
            io.to(`class:${existing.id}`).emit('class:ended', { sessionId: existing.id });
            liveClasses.delete(existing.id);
          }
        }
        const timetable = await TimetableEntry.findOne({ course: course._id, teacher: socket.data.userId }).select('meetingLink');
        const session = {
          id: crypto.randomUUID(), courseId: String(course._id), courseTitle: course.title,
          teacherId: socket.data.userId, teacherName: course.teacher.fullName,
          slides: payload.slides.map((slide) => ({
            title: String(slide.title || '').slice(0, 300),
            bullets: (slide.bullets || []).slice(0, 20).map((b) => String(b).slice(0, 2000)),
            background: safeColor(slide.background, '#fff8e7'), accent: safeColor(slide.accent, '#d97706'), text: safeColor(slide.text, '#1f2937'),
            imageUrl: /^https:\/\//i.test(slide.imageUrl || slide.image || '') ? (slide.imageUrl || slide.image) : ''
          })),
          currentSlide: 0, meetingLink: timetable?.meetingLink || '', startedAt: new Date(), messages: [],
          participants: new Map(), raisedHands: new Map()
        };
        liveClasses.set(session.id, session);
        socket.join(`class:${session.id}`); socket.data.liveSessionIds.add(session.id);
        session.participants.set(socket.data.userId, { userId: socket.data.userId, name: course.teacher.fullName, teacher: true });
        const enrollments = await Enrollment.find({ course: course._id, status: { $ne: 'dropped' } }).select('student');
        enrollments.forEach((row) => io.to(`user:${row.student}`).emit('class:started', publicSession(session)));
        reply({ ok: true, session: { ...publicSession(session), slides: session.slides, messages: [] } });
      } catch (error) { reply({ ok: false, message: error.message }); }
    });

    socket.on('class:list', async (_, reply = () => {}) => {
      try {
        const result = [];
        for (const session of liveClasses.values()) {
          const course = await Course.findById(session.courseId);
          if (!course) continue;
          if (session.teacherId === socket.data.userId) result.push(publicSession(session));
          else {
            try { await authorizeStudent(socket.data.userId, course); result.push(publicSession(session)); } catch { /* not eligible */ }
          }
        }
        reply({ ok: true, sessions: result });
      } catch (error) { reply({ ok: false, message: error.message }); }
    });

    socket.on('class:join', async ({ sessionId } = {}, reply = () => {}) => {
      try {
        const session = liveClasses.get(sessionId);
        if (!session) throw new Error('This live class has ended.');
        const course = await Course.findById(session.courseId);
        if (session.teacherId !== socket.data.userId) await authorizeStudent(socket.data.userId, course);
        socket.join(`class:${session.id}`); socket.data.liveSessionIds.add(session.id);
        const user = await User.findById(socket.data.userId).select('fullName');
        // Tracked in the session (not just a one-off event) so a teacher/student who reloads mid-
        // class gets the real current roster back from class:join/class:list, not an empty one —
        // the previous version only ever broadcast a transient "someone joined" ping.
        session.participants.set(socket.data.userId, { userId: socket.data.userId, name: user?.fullName || 'Participant', teacher: session.teacherId === socket.data.userId });
        io.to(`class:${session.id}`).emit('class:participant', { userId: socket.data.userId, name: user?.fullName || 'Participant', joined: true });
        reply({ ok: true, session: { ...publicSession(session), slides: session.slides, messages: session.messages } });
      } catch (error) { reply({ ok: false, message: error.message }); }
    });

    socket.on('class:leave', ({ sessionId } = {}, reply = () => {}) => {
      const session = liveClasses.get(sessionId);
      if (session && socket.data.liveSessionIds.has(sessionId)) {
        session.participants.delete(socket.data.userId);
        session.raisedHands.delete(socket.data.userId);
        io.to(`class:${session.id}`).emit('class:participant', { userId: socket.data.userId, joined: false });
      }
      socket.leave(`class:${sessionId}`);
      socket.data.liveSessionIds.delete(sessionId);
      reply({ ok: true });
    });

    socket.on('class:control', ({ sessionId, currentSlide } = {}, reply = () => {}) => {
      const session = liveClasses.get(sessionId);
      if (!session || session.teacherId !== socket.data.userId) return reply({ ok: false, message: 'Teacher control rejected.' });
      if (tooFast(`ctl:${sessionId}`, 20, 5000)) return reply({ ok: false, message: 'Too many slide changes too fast.' });
      const next = Math.max(0, Math.min(session.slides.length - 1, Number(currentSlide) || 0));
      session.currentSlide = next;
      io.to(`class:${session.id}`).emit('class:slide', { sessionId, currentSlide: next });
      reply({ ok: true });
    });

    socket.on('class:message', async ({ sessionId, text } = {}, reply = () => {}) => {
      try {
        const session = liveClasses.get(sessionId);
        if (!session || !socket.data.liveSessionIds.has(sessionId)) throw new Error('Join the class before sending a message.');
        if (tooFast(`msg:${socket.data.userId}:${sessionId}`, 8, 10000)) throw new Error('You are sending messages too fast — slow down.');
        const clean = String(text || '').trim().slice(0, 1000);
        if (!clean) throw new Error('Message is empty.');
        const user = await User.findById(socket.data.userId).select('fullName');
        const message = { id: crypto.randomUUID(), userId: socket.data.userId, name: user?.fullName || 'Participant', text: clean, at: new Date().toISOString(), teacher: session.teacherId === socket.data.userId };
        session.messages.push(message); if (session.messages.length > 200) session.messages.shift();
        io.to(`class:${session.id}`).emit('class:message', message); reply({ ok: true });
      } catch (error) { reply({ ok: false, message: error.message }); }
    });

    socket.on('class:raise-hand', async ({ sessionId, raised = true } = {}, reply = () => {}) => {
      try {
        const session = liveClasses.get(sessionId);
        if (!session || !socket.data.liveSessionIds.has(sessionId) || session.teacherId === socket.data.userId) throw new Error('Student hand-raise rejected.');
        const user = await User.findById(socket.data.userId).select('fullName');
        const name = user?.fullName || 'Student';
        if (raised) session.raisedHands.set(socket.data.userId, { userId: socket.data.userId, name, at: new Date().toISOString() });
        else session.raisedHands.delete(socket.data.userId);
        io.to(`class:${session.id}`).emit('class:hand', { userId: socket.data.userId, name, raised: Boolean(raised) }); reply({ ok: true });
      } catch (error) { reply({ ok: false, message: error.message }); }
    });

    socket.on('class:end', ({ sessionId } = {}, reply = () => {}) => {
      const session = liveClasses.get(sessionId);
      if (!session || session.teacherId !== socket.data.userId) return reply({ ok: false, message: 'Only the teacher can end this class.' });
      io.to(`class:${session.id}`).emit('class:ended', { sessionId }); liveClasses.delete(session.id); reply({ ok: true });
    });

    socket.on('disconnect', () => {
      clearTimeout(expiryTimer);
      // A closed tab / dropped connection never fires class:leave, so the roster (and raised
      // hand, if any) would otherwise stay stuck showing someone who is no longer there.
      for (const sessionId of socket.data.liveSessionIds) {
        const session = liveClasses.get(sessionId);
        if (!session) continue;
        session.participants.delete(socket.data.userId);
        session.raisedHands.delete(socket.data.userId);
        io.to(`class:${session.id}`).emit('class:participant', { userId: socket.data.userId, joined: false });
      }
    });
  });

  return io;
}

// Push a live update to every tab a specific user has open.
function emitToUser(userId, event, payload) {
  if (io && userId) io.to(`user:${userId}`).emit(event, payload);
}

module.exports = { initSocket, emitToUser };
