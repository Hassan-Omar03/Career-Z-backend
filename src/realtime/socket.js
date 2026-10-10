const { Server } = require('socket.io');
const env = require('../config/env');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Course = require('../models/Course');
const Enrollment = require('../models/Enrollment');
const TimetableEntry = require('../models/TimetableEntry');
const LiveClassSession = require('../models/LiveClassSession');
const StudyGroup = require('../models/StudyGroup');
const ClassEngagementRecord = require('../models/ClassEngagementRecord');
const classroomLifecycle = require('../services/classroomLifecycle.service');
const { assertFeeAccessForCapability } = require('../utils/feeAccess');
const crypto = require('crypto');

let io = null;
// Live classrooms are deliberately ephemeral. The durable deck remains a Lesson/Class Resource;
// this map only represents the currently-running teaching session and is discarded on restart.
const liveClasses = new Map();
const videoRoomMembers = new Map();
const liveVideoPolls = new Map();
const liveVideoEnergy = new Map();

function publicSession(session) {
  return {
    id: session.id, courseId: session.courseId, courseTitle: session.courseTitle, teacherName: session.teacherName,
    currentSlide: session.currentSlide, meetingLink: session.meetingLink, startedAt: session.startedAt, liveClassSessionId: session.liveClassSessionId || null,
    participants: Array.from(session.participants.values()),
    raisedHands: Array.from(session.raisedHands.values())
  };
}

// Persists this session's Class Energy Meter + poll outcome once it ends — the live in-memory
// session stays ephemeral (see module comment), but its engagement summary becomes real history
// a teacher/institution can review later (spec: "historical engagement analytics").
async function persistEngagementRecord(session) {
  const rows = Array.from(session.energy?.values?.() || []);
  const summary = { averageEnergy: rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : null, attentiveCount: rows.filter((r) => r.attentive).length, participantCount: Math.max(0, (session.participants?.size || 1) - 1), record: null };
  try {
    if (session.participants && session.participants.size > 1) { // teacher-only = nothing to keep
    const course = await Course.findById(session.courseId).select('institution');
    const record = await ClassEngagementRecord.create({
      institution: course?.institution || null,
      course: session.courseId,
      liveClassSession: session.liveClassSessionId || null,
      teacher: session.teacherId,
      startedAt: session.startedAt,
      endedAt: new Date(),
      participantCount: session.participants.size - 1,
      averageEnergy: rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : null,
      attentiveCount: rows.filter((r) => r.attentive).length,
      roster: rows.map((r) => ({ student: r.userId, name: r.name, attentive: r.attentive, score: r.score })),
      poll: session.poll ? { question: session.poll.question, options: session.poll.options.map((o) => ({ text: o.text, votes: o.votes })) } : undefined
    });
    summary.record = record._id;
    }
    // One classroom lifecycle: the linked scheduled class keeps this engagement and is ended too.
    if (session.liveClassSessionId) await classroomLifecycle.finish(session.liveClassSessionId, session.teacherId, summary);
  } catch { /* best-effort — never blocks the class from actually ending */ }
}

// Same rule as the notification fix in course.controller.js: a student whose enrollment already
// flipped to 'completed' (via the weighted completion engine) is still a real, current member of
// the course — e.g. attending a live revision session after finishing — and must not be treated
// as unenrolled. Only 'dropped' actually means they're no longer part of the course.
async function authorizeStudent(userId, course) {
  const enrollment = await Enrollment.findOne({ student: userId, course: course._id, status: { $ne: 'dropped' } });
  if (!enrollment) throw new Error('You are not enrolled in this course.');
  if (course.institution) {
    try { await assertFeeAccessForCapability(userId, course.institution, 'live_classes'); }
    catch (err) { throw new Error(err.message || 'A due fee is blocking live-class access.'); }
  }
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
    socket.data.videoSessionIds = new Set();

    // A message sent while this user was offline gets its "delivered" mark now, the moment they
    // actually come online — and the original sender is told live, without needing to reload.
    (async () => {
      const Message = require('../models/Message');
      const now = new Date();
      const undelivered = await Message.find({ to: socket.data.userId, deliveredAt: null }).select('_id from');
      if (undelivered.length === 0) return;
      await Message.updateMany({ _id: { $in: undelivered.map((m) => m._id) } }, { $set: { deliveredAt: now } });
      const bySender = new Map();
      undelivered.forEach((m) => bySender.set(m.from.toString(), (bySender.get(m.from.toString()) || 0) + 1));
      bySender.forEach((count, senderId) => io.to(`user:${senderId}`).emit('message:delivered', { to: socket.data.userId, at: now, count }));
    })().catch(() => {});

    socket.on('live-video:join', async ({ sessionId, group, observeStudentId }  = {}, reply = () => {}) => {
      try {
        const session = await LiveClassSession.findById(sessionId).populate('teacher', 'fullName');
        if (!session || session.status !== 'live') throw new Error('This class is not live.');
        const isTeacher = String(session.teacher._id) === socket.data.userId;
        const isObserver=!!observeStudentId&&!isTeacher;
        if(isObserver)await require('../services/guardianObservation.service').authorize(socket.data.userId,session,observeStudentId);
        if (!isTeacher&&!isObserver) {
          const course = await Course.findById(session.course);
          await authorizeStudent(socket.data.userId, course);
        }
        const user = await User.findById(socket.data.userId).select('fullName');
        if (session.mode === 'physical' && !isTeacher) throw new Error('Physical classes use on-campus attendance.');
        const assigned = session.breakoutGroups?.find(g => g.students.some(id => String(id) === socket.data.userId));
        const groupName = isTeacher && group && session.breakoutGroups.some(g => g.name === group) ? group : (!isTeacher && assigned?.name) || 'main';
        const baseRoom = `live-video:${sessionId}`;
        const room = baseRoom + ':group:' + groupName;
        const previous = videoRoomMembers.get(sessionId)?.get(socket.data.userId);
        if (previous) socket.to(baseRoom + ':group:' + (previous.group || 'main')).emit('live-video:participant-left', previous);
        for (const joinedRoom of socket.rooms) if (joinedRoom.startsWith(baseRoom + ':group:')) socket.leave(joinedRoom);
        socket.join(baseRoom);
        if(!isTeacher&&!isObserver)await LiveClassSession.updateOne({_id:sessionId,status:'live','participants.student':{$ne:socket.data.userId}},{$push:{participants:{student:socket.data.userId,joinedAt:new Date(),attendanceStatus:'present'}}});
        const members = videoRoomMembers.get(sessionId) || new Map();
        const existing = Array.from(members.values()).filter(m=>m.group===groupName&&m.userId!==socket.data.userId);
        const member = { userId: socket.data.userId, name: user?.fullName || (isTeacher ? 'Teacher' : 'Student'), role: isTeacher ? 'teacher' : isObserver?'observer':'student',observedStudentId:isObserver?String(observeStudentId):null,institution:String(session.institution),group:groupName };
        members.set(socket.data.userId, member); videoRoomMembers.set(sessionId, members);
        socket.join(room); socket.data.videoSessionIds.add(sessionId);
        socket.to(room).emit('live-video:participant-joined', member);
        reply({ ok: true, participants: existing, self: member, poll: liveVideoPolls.get(sessionId) || null, group:groupName });
      } catch (error) { reply({ ok: false, message: error.message }); }
    });

    socket.on('live-video:signal',async({sessionId,targetUserId,signal}={},reply=()=>{})=>{
      try{const members=videoRoomMembers.get(sessionId),sender=members?.get(socket.data.userId),target=members?.get(String(targetUserId));if(!sender||!target||sender.group!==target.group)throw new Error('Classroom signaling rejected.');
      for(const member of [sender,target])if(member.role==='observer')await require('../services/guardianObservation.service').authorize(member.userId,sessionId,member.observedStudentId);
      if(sender.role==='observer'&&!require('../services/guardianObservation.service').receiveOnly(signal?.description))throw new Error('Observers may only receive classroom media.');
      io.to(`user:${targetUserId}`).emit('live-video:signal',{sessionId,fromUserId:socket.data.userId,signal});reply({ok:true});}catch(e){reply({ok:false,message:e.message});}
    });

    socket.on('live-video:message', async ({ sessionId, text } = {}, reply = () => {}) => {
      try {
        const members = videoRoomMembers.get(sessionId);
        if (!members?.has(socket.data.userId)) throw new Error('Join the classroom first.');
        if(members.get(socket.data.userId).role==='observer')throw new Error('Observation is read-only.');
        const session=await LiveClassSession.findById(sessionId);
        if(!session||session.status!=='live')throw new Error('Class ended.');
        if(members.get(socket.data.userId).role!=='teacher'&&session.classroomPolicy?.chatAllowed===false)throw new Error('Teacher disabled student chat.');
        const clean = String(text || '').trim().slice(0, 1000);
        if (!clean) throw new Error('Message is empty.');
        const member = members.get(socket.data.userId);
        const message = { id: crypto.randomUUID(), userId: socket.data.userId, name: member.name, role: member.role, text: clean, at: new Date().toISOString() };
        io.to(`live-video:${sessionId}:group:${member.group||'main'}`).emit('live-video:message', message); reply({ ok: true });
      } catch (error) { reply({ ok: false, message: error.message }); }
    });

    socket.on('live-video:hand', ({ sessionId, raised } = {}, reply = () => {}) => {
      const members = videoRoomMembers.get(sessionId);
      if (!members?.has(socket.data.userId)||members.get(socket.data.userId).role==='observer') return reply({ ok: false, message: 'Observation is read-only.' });
      const member = members.get(socket.data.userId);
      io.to(`live-video:${sessionId}`).emit('live-video:hand', { ...member, raised: Boolean(raised) }); reply({ ok: true });
    });

    socket.on('live-video:energy-report', ({ sessionId, attentive, score } = {}, reply = () => {}) => {
      const members = videoRoomMembers.get(sessionId); const member = members?.get(socket.data.userId);
      if (!member || member.role !== 'student') return reply({ ok: false, message: 'Student energy report rejected.' });
      const readings = liveVideoEnergy.get(sessionId) || new Map();
      readings.set(socket.data.userId, { userId: socket.data.userId, name: member.name, attentive: Boolean(attentive), score: Math.max(0, Math.min(100, Number(score) || 0)), at: new Date().toISOString() });
      liveVideoEnergy.set(sessionId, readings);
      const roster = Array.from(readings.values()); const average = roster.length ? Math.round(roster.reduce((sum, row) => sum + row.score, 0) / roster.length) : 0;
      io.to(`live-video:${sessionId}`).emit('live-video:energy', { sessionId, average, attentiveCount: roster.filter((row) => row.attentive).length, total: roster.length });
      const teacher = Array.from(members.values()).find((row) => row.role === 'teacher');
      if (teacher) io.to(`user:${teacher.userId}`).emit('live-video:energy-detail', { sessionId, average, attentiveCount: roster.filter((row) => row.attentive).length, total: roster.length, roster });
      reply({ ok: true });
    });

    socket.on('live-video:poll-create', ({ sessionId, question, options } = {}, reply = () => {}) => {
      const members = videoRoomMembers.get(sessionId); const member = members?.get(socket.data.userId);
      if (!member || member.role !== 'teacher') return reply({ ok: false, message: 'Only the class teacher can create a poll.' });
      const cleanQuestion = String(question || '').trim().slice(0, 300);
      const cleanOptions = Array.isArray(options) ? options.map((option) => String(option || '').trim().slice(0, 120)).filter(Boolean).slice(0, 6) : [];
      if (!cleanQuestion || cleanOptions.length < 2) return reply({ ok: false, message: 'A question and at least two options are required.' });
      const poll = { id: crypto.randomUUID(), question: cleanQuestion, options: cleanOptions.map((text, index) => ({ index, text, votes: 0 })), voters: {}, status: 'open' };
      liveVideoPolls.set(sessionId, poll); io.to(`live-video:${sessionId}`).emit('live-video:poll', poll); reply({ ok: true, poll });
    });

    socket.on('live-video:poll-vote', ({ sessionId, optionIndex } = {}, reply = () => {}) => {
      const members = videoRoomMembers.get(sessionId); const poll = liveVideoPolls.get(sessionId);
      if (!members?.has(socket.data.userId) || members.get(socket.data.userId).role!=='student' || !poll || poll.status !== 'open') return reply({ ok: false, message: 'No open poll is available.' });
      const index = Number(optionIndex); if (!poll.options[index]) return reply({ ok: false, message: 'Invalid poll option.' });
      const previous = poll.voters[socket.data.userId]; if (previous !== undefined) poll.options[previous].votes -= 1;
      poll.voters[socket.data.userId] = index; poll.options[index].votes += 1;
      io.to(`live-video:${sessionId}`).emit('live-video:poll', poll); reply({ ok: true });
    });

    socket.on('live-video:poll-close', ({ sessionId } = {}, reply = () => {}) => {
      const member = videoRoomMembers.get(sessionId)?.get(socket.data.userId); const poll = liveVideoPolls.get(sessionId);
      if (!member || member.role !== 'teacher' || !poll) return reply({ ok: false, message: 'Only the class teacher can close this poll.' });
      poll.status = 'closed'; io.to(`live-video:${sessionId}`).emit('live-video:poll', poll); reply({ ok: true });
    });

    socket.on('live-video:leave', ({ sessionId } = {}, reply = () => {}) => {
      const members = videoRoomMembers.get(sessionId);
      const member = members?.get(socket.data.userId);
      members?.delete(socket.data.userId);
      liveVideoEnergy.get(sessionId)?.delete(socket.data.userId);
      if (members?.size === 0) { videoRoomMembers.delete(sessionId); liveVideoPolls.delete(sessionId); liveVideoEnergy.delete(sessionId); }
      for (const room of socket.rooms) if (room.startsWith(`live-video:${sessionId}:group:`)) socket.leave(room);
      socket.leave(`live-video:${sessionId}`); socket.data.videoSessionIds.delete(sessionId);
      if (member) socket.to(`live-video:${sessionId}`).emit('live-video:participant-left', member);
      reply({ ok: true });
    });

    // Study Groups: durable discussion (persisted via StudyGroupPost, not ephemeral like a live
    // class) — the socket room only exists to push new posts instantly to members who are online;
    // a reload/poll of GET .../posts is still the source of truth.
    socket.on('study-group:join', async ({ groupId } = {}, reply = () => {}) => {
      try {
        const group = await StudyGroup.findById(groupId).select('members');
        if (!group || !group.members.some((m) => m.user.toString() === socket.data.userId)) {
          throw new Error('You are not a member of this study group.');
        }
        socket.join(`study-group:${groupId}`);
        socket.data.studyGroupIds = socket.data.studyGroupIds || new Set();
        socket.data.studyGroupIds.add(groupId);
        reply({ ok: true });
      } catch (error) { reply({ ok: false, message: error.message }); }
    });

    socket.on('study-group:leave', ({ groupId } = {}, reply = () => {}) => {
      socket.leave(`study-group:${groupId}`);
      socket.data.studyGroupIds?.delete(groupId);
      reply({ ok: true });
    });

    // Group conversations (messaging spec) — same durable-message-plus-live-push pattern as
    // Study Groups above.
    socket.on('group:join', async ({ groupId } = {}, reply = () => {}) => {
      try {
        const GroupConversation = require('../models/GroupConversation');
        const group = await GroupConversation.findById(groupId);
        if (!group || !await require('../services/guardianGroupAccess.service').eligible(group,socket.data.userId)) {
          throw new Error('You are not a member of this group.');
        }
        socket.join(`group:${groupId}`);
        reply({ ok: true });
      } catch (error) { reply({ ok: false, message: error.message }); }
    });

    socket.on('group:leave', ({ groupId } = {}, reply = () => {}) => {
      socket.leave(`group:${groupId}`);
      reply({ ok: true });
    });

    socket.on('class:start', async (payload = {}, reply = () => {}) => {
      try {
        const course = await Course.findById(payload.courseId).populate('teacher', 'fullName');
        if (!course || String(course.teacher._id) !== socket.data.userId) throw new Error('Only the course teacher can start this class.');
        if (!Array.isArray(payload.slides) || payload.slides.length < 1 || payload.slides.length > 50) throw new Error('A live class needs 1–50 slides.');
        for (const existing of liveClasses.values()) {
          if (existing.teacherId === socket.data.userId) {
            io.to(`class:${existing.id}`).emit('class:ended', { sessionId: existing.id });
            persistEngagementRecord(existing);
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
          participants: new Map(), raisedHands: new Map(),
          // Class Energy Meter (spec #17) — each online student's own locally-computed attention
          // reading (never another student's, only the teacher/institution see the roster).
          energy: new Map(),
          poll: null
        };
        // Attach to (and start) this course's scheduled class happening now, if there is one.
        session.liveClassSessionId = await classroomLifecycle.linkLiveSession({ courseId: course._id, teacherId: socket.data.userId, requestedId: payload.liveClassSessionId || null }).catch(() => null);
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
        if (session.liveClassSessionId && session.teacherId !== socket.data.userId) await classroomLifecycle.recordJoin(session.liveClassSessionId, socket.data.userId).catch(() => {});
        io.to(`class:${session.id}`).emit('class:participant', { userId: socket.data.userId, name: user?.fullName || 'Participant', joined: true });
        reply({ ok: true, session: { ...publicSession(session), slides: session.slides, messages: session.messages } });
      } catch (error) { reply({ ok: false, message: error.message }); }
    });

    socket.on('class:leave', ({ sessionId } = {}, reply = () => {}) => {
      const session = liveClasses.get(sessionId);
      if (session && socket.data.liveSessionIds.has(sessionId)) {
        session.participants.delete(socket.data.userId);
        session.raisedHands.delete(socket.data.userId);
        session.energy.delete(socket.data.userId);
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

    // Class Energy Meter (spec #17) — a student's browser runs its own lightweight face-presence
    // check and reports only a boolean "attentive" reading + score; the server never receives
    // video/images, just the derived reading. Aggregate goes to the whole room (so a student's own
    // tile updates), but the per-student roster is only ever pushed to the teacher (and, via
    // institution:energy:subscribe, an institution owner/staff member watching that class) —
    // never broadcast to other students, matching the spec's visibility rule.
    socket.on('class:energy:report', async ({ sessionId, attentive, score } = {}, reply = () => {}) => {
      try {
        const session = liveClasses.get(sessionId);
        if (!session || !socket.data.liveSessionIds.has(sessionId) || session.teacherId === socket.data.userId) throw new Error('Student energy report rejected.');
        const user = await User.findById(socket.data.userId).select('fullName');
        session.energy.set(socket.data.userId, { userId: socket.data.userId, name: user?.fullName || 'Student', attentive: Boolean(attentive), score: Math.max(0, Math.min(100, Number(score) || 0)), at: new Date().toISOString() });
        const rows = Array.from(session.energy.values());
        const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0;
        const attentiveCount = rows.filter((r) => r.attentive).length;
        io.to(`class:${session.id}`).emit('class:energy', { sessionId, average: avg, attentiveCount, total: rows.length });
        io.to(`user:${session.teacherId}`).emit('class:energy:detail', { sessionId, average: avg, attentiveCount, total: rows.length, roster: rows });
        reply({ ok: true });
      } catch (error) { reply({ ok: false, message: error.message }); }
    });

    // The concrete "action a teacher can take" on a distracted reading from the Energy Meter — a
    // gentle, visible nudge straight to that one student (never broadcast to the room, so it
    // doesn't call the student out in front of the class).
    socket.on('class:energy:nudge', ({ sessionId, studentId } = {}, reply = () => {}) => {
      const session = liveClasses.get(sessionId);
      if (!session || session.teacherId !== socket.data.userId) return reply({ ok: false, message: 'Only the teacher can nudge a student.' });
      if (!session.participants.has(studentId)) return reply({ ok: false, message: 'That student is not currently in the class.' });
      io.to(`user:${studentId}`).emit('class:energy:nudged', { sessionId, teacherName: session.teacherName });
      reply({ ok: true });
    });

    // Live in-class poll — ephemeral like the class session itself (mirrors live-video:poll),
    // separate from the async /polls module which is for take-home/between-class questions.
    socket.on('class:poll:start', ({ sessionId, question, options } = {}, reply = () => {}) => {
      const session = liveClasses.get(sessionId);
      if (!session || session.teacherId !== socket.data.userId) return reply({ ok: false, message: 'Only the teacher can start a poll.' });
      const cleanQuestion = String(question || '').trim().slice(0, 300);
      const cleanOptions = (Array.isArray(options) ? options : []).map((o) => String(o || '').trim().slice(0, 120)).filter(Boolean).slice(0, 6);
      if (!cleanQuestion || cleanOptions.length < 2) return reply({ ok: false, message: 'A poll needs a question and at least 2 options.' });
      session.poll = { id: crypto.randomUUID(), question: cleanQuestion, options: cleanOptions.map((text, index) => ({ index, text, votes: 0 })), voters: {}, status: 'open' };
      io.to(`class:${session.id}`).emit('class:poll', session.poll);
      reply({ ok: true, poll: session.poll });
    });

    socket.on('class:poll:vote', ({ sessionId, optionIndex } = {}, reply = () => {}) => {
      const session = liveClasses.get(sessionId);
      if (!session || !socket.data.liveSessionIds.has(sessionId) || !session.poll || session.poll.status !== 'open') return reply({ ok: false, message: 'No open poll right now.' });
      const index = Number(optionIndex);
      if (!session.poll.options[index]) return reply({ ok: false, message: 'Invalid poll option.' });
      const previous = session.poll.voters[socket.data.userId];
      if (previous !== undefined) session.poll.options[previous].votes -= 1;
      session.poll.voters[socket.data.userId] = index;
      session.poll.options[index].votes += 1;
      io.to(`class:${session.id}`).emit('class:poll', session.poll);
      reply({ ok: true });
    });

    socket.on('class:poll:close', ({ sessionId } = {}, reply = () => {}) => {
      const session = liveClasses.get(sessionId);
      if (!session || session.teacherId !== socket.data.userId || !session.poll) return reply({ ok: false, message: 'Only the teacher can close this poll.' });
      session.poll.status = 'closed';
      io.to(`class:${session.id}`).emit('class:poll', session.poll);
      reply({ ok: true });
    });

    // Institution owner/staff watching a class live (spec #17 allows institution visibility) —
    // read-only: joins the room to receive class:energy/class:poll/class:slide broadcasts, but
    // is never added to `participants` and can never call class:control/class:message.
    socket.on('institution:class:watch', async ({ sessionId } = {}, reply = () => {}) => {
      try {
        const session = liveClasses.get(sessionId);
        if (!session) throw new Error('This live class has ended.');
        const course = await Course.findById(session.courseId);
        if (!course?.institution) throw new Error('This class is not linked to an institution.');
        const Institution = require('../models/Institution');
        const institution = await Institution.findById(course.institution);
        const isOwner = institution?.owner?.toString() === socket.data.userId;
        const isStaff = institution?.staff?.some((s) => s.user.toString() === socket.data.userId);
        if (!isOwner && !isStaff) throw new Error('You are not part of this institution.');
        socket.join(`class:${session.id}`);
        reply({ ok: true, session: { ...publicSession(session), slides: session.slides } });
      } catch (error) { reply({ ok: false, message: error.message }); }
    });

    socket.on('class:end', ({ sessionId } = {}, reply = () => {}) => {
      const session = liveClasses.get(sessionId);
      if (!session || session.teacherId !== socket.data.userId) return reply({ ok: false, message: 'Only the teacher can end this class.' });
      io.to(`class:${session.id}`).emit('class:ended', { sessionId });
      persistEngagementRecord(session);
      liveClasses.delete(session.id);
      reply({ ok: true });
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
        session.energy.delete(socket.data.userId);
        io.to(`class:${session.id}`).emit('class:participant', { userId: socket.data.userId, joined: false });
      }
      for (const sessionId of socket.data.videoSessionIds) {
        const members = videoRoomMembers.get(sessionId);
        const member = members?.get(socket.data.userId);
        members?.delete(socket.data.userId);
        if (members?.size === 0) { videoRoomMembers.delete(sessionId); liveVideoPolls.delete(sessionId); liveVideoEnergy.delete(sessionId); }
        if (member) socket.to(`live-video:${sessionId}`).emit('live-video:participant-left', member);
      }
    });
  });

  return io;
}

// Push a live update to every tab a specific user has open.
function emitToUser(userId, event, payload) {
  if (io && userId) io.to(`user:${userId}`).emit(event, payload);
}

function emitToLiveVideoRoom(sessionId, event, payload) {
  if (io && sessionId) io.to(`live-video:${sessionId}`).emit(event, payload);
  if(event==='live-video:ended'){videoRoomMembers.delete(String(sessionId));liveVideoPolls.delete(String(sessionId));liveVideoEnergy.delete(String(sessionId));}
}

// Push a freshly-created discussion post to every online member of a study group.
function broadcastStudyGroupPost(groupId, post) {
  if (io && groupId) io.to(`study-group:${groupId}`).emit('study-group:message', post);
}

// Push a freshly-sent group message to every online participant.
async function broadcastGroupMessage(groupId,message){
 if(!io||!groupId)return;const group=await require('../models/GroupConversation').findById(groupId);if(!group)return;
 for(const user of group.participants){if(!await require('../services/guardianGroupAccess.service').eligible(group,user))continue;
 if(await require('../models/BlockedUser').exists({$or:[{blocker:user,blocked:message.from._id||message.from},{blocker:message.from._id||message.from,blocked:user}]}))continue;
 emitToUser(user,'group:message',message);}
}

// Whether a user currently has at least one open tab connected — used as the "delivered" signal
// for a message sent to them (they had a live connection the instant it was sent).
function isUserOnline(userId) {
  if (!io || !userId) return false;
  const room = io.sockets.adapter.rooms.get(`user:${userId}`);
  return Boolean(room && room.size > 0);
}

async function revokeObservers(predicate){for(const [sessionId,members] of videoRoomMembers){for(const [id,member] of members){if(member.role!=='observer'||!predicate(member))continue;members.delete(id);emitToUser(id,'live-video:ended',{sessionId});if(io){io.to(`live-video:${sessionId}`).emit('live-video:participant-left',member);for(const socket of await io.in(`user:${id}`).fetchSockets()){socket.leave(`live-video:${sessionId}`);socket.leave(`live-video:${sessionId}:group:main`);}}}}}
async function revokeGuardianObservers(parent,student){await revokeObservers(m=>String(m.userId)===String(parent)&&String(m.observedStudentId)===String(student));}
async function revokeInstitutionObservers(institution){await revokeObservers(m=>String(m.institution)===String(institution));}
async function revokeStudentObservers(student,institution){await revokeObservers(m=>String(m.observedStudentId)===String(student)&&(!institution||String(m.institution)===String(institution)));}
module.exports = {revokeStudentObservers,revokeGuardianObservers,revokeInstitutionObservers, initSocket, emitToUser, emitToLiveVideoRoom, broadcastStudyGroupPost, isUserOnline, broadcastGroupMessage };
