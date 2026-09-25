const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.NODE_ENV = 'test';
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});

const User = require('../src/models/User');
const Institution = require('../src/models/Institution');
const StudentProfile = require('../src/models/StudentProfile');
const TeacherProfile = require('../src/models/TeacherProfile');
const StudentGoal = require('../src/models/StudentGoal');
const Achievement = require('../src/models/Achievement');
const Badge = require('../src/models/Badge');
const ctrl = require('../src/controllers/student.controller');

let mongo, teacher, student, outsiderTeacher, institution;
const models = [User, Institution, StudentProfile, TeacherProfile, StudentGoal, Achievement, Badge];

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(models.map((m) => m.init()));
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });

function invoke(handler, { user, params = {}, body = {}, query = {} }) {
  return new Promise((resolve) => {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json(value) { resolve({ status, body: value }); return this; } };
    const next = (err) => resolve({ status: err?.statusCode || 500, body: { message: err?.message } });
    Promise.resolve(handler({ user, params, body, query }, res, next)).catch(next);
  });
}

beforeEach(async () => {
  await Promise.all(models.map((m) => m.deleteMany({})));
  teacher = await User.create({ fullName: 'Reviewer Teacher', email: 'ga-teacher@test.local', passwordHash: 'x', roles: ['teacher'] });
  outsiderTeacher = await User.create({ fullName: 'Outsider Teacher', email: 'ga-outsider@test.local', passwordHash: 'x', roles: ['teacher'] });
  student = await User.create({ fullName: 'Goal Student', email: 'ga-student@test.local', passwordHash: 'x', roles: ['student'] });
  institution = await Institution.create({ name: 'GA Institution', slug: 'ga-institution', type: 'school', country: 'PK', owner: teacher._id, verificationStatus: 'approved' });
  await StudentProfile.create({ user: student._id, primaryInstitution: institution._id });
  await TeacherProfile.create({ user: teacher._id, institutions: [institution._id] });
});

test('a skill goal completes on self-report; an academic goal needs evidence + teacher verification', async () => {
  const skillGoal = await invoke(ctrl.addMyGoal, { user: student, body: { title: 'Learn TypeScript', category: 'skill' } });
  const skillUpdate = await invoke(ctrl.updateMyGoal, { user: student, params: { id: skillGoal.body.data._id }, body: { progressPercent: 100 } });
  assert.equal(skillUpdate.status, 200);
  assert.equal(skillUpdate.body.data.status, 'completed');

  const academicGoal = await invoke(ctrl.addMyGoal, { user: student, body: { title: 'IELTS 8.0', category: 'academic' } });
  const noEvidence = await invoke(ctrl.updateMyGoal, { user: student, params: { id: academicGoal.body.data._id }, body: { progressPercent: 100 } });
  assert.equal(noEvidence.status, 422, 'reaching 100% on an academic goal without evidence must be rejected');

  const withEvidence = await invoke(ctrl.updateMyGoal, { user: student, params: { id: academicGoal.body.data._id }, body: { progressPercent: 100, evidenceUrl: 'https://example.com/ielts.pdf' } });
  assert.equal(withEvidence.body.data.status, 'pending_verification');

  const queue = await invoke(ctrl.goalReviewQueue, { user: teacher });
  assert.equal(queue.body.data.length, 1);
  const outsiderQueue = await invoke(ctrl.goalReviewQueue, { user: outsiderTeacher });
  assert.equal(outsiderQueue.body.data.length, 0, 'a teacher outside the student institution never sees the queue');

  const approve = await invoke(ctrl.reviewGoal, { user: teacher, params: { id: academicGoal.body.data._id }, body: { approve: true, notes: 'Score report checks out.' } });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.data.status, 'completed');

  const timeline = await invoke(ctrl.getMyAchievementTimeline, { user: student });
  assert.ok(timeline.body.data.some((t) => t.type === 'Goal Achieved' && t.title === 'IELTS 8.0'));
});

test('milestones drive progressPercent automatically', async () => {
  const goal = await invoke(ctrl.addMyGoal, { user: student, body: { title: 'Build a portfolio', category: 'skill', milestones: [{ title: 'Design' }, { title: 'Build' }, { title: 'Deploy' }] } });
  const milestoneId = goal.body.data.milestones[0]._id;
  const toggled = await invoke(ctrl.toggleGoalMilestone, { user: student, params: { id: goal.body.data._id, milestoneId }, body: { done: true } });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.body.data.progressPercent, 33);
});

test('a manual achievement stays pending (invisible in the verified timeline) until an institution reviewer verifies it', async () => {
  const add = await invoke(ctrl.addMyAchievement, { user: student, body: { type: 'award', title: 'Regional Science Fair Winner', evidenceUrl: 'https://example.com/cert.png' } });
  assert.equal(add.status, 201);
  assert.equal(add.body.data.verificationStatus, 'pending');

  const timelineBefore = await invoke(ctrl.getMyAchievementTimeline, { user: student });
  assert.ok(!timelineBefore.body.data.some((t) => t.title === 'Regional Science Fair Winner'));

  const forbidden = await invoke(ctrl.reviewAchievement, { user: outsiderTeacher, params: { id: add.body.data._id }, body: { approve: true } });
  assert.equal(forbidden.status, 403);

  const review = await invoke(ctrl.reviewAchievement, { user: teacher, params: { id: add.body.data._id }, body: { approve: true, notes: 'Verified with the event organizer.' } });
  assert.equal(review.status, 200);
  assert.equal(review.body.data.verificationStatus, 'verified');

  const timelineAfter = await invoke(ctrl.getMyAchievementTimeline, { user: student });
  assert.ok(timelineAfter.body.data.some((t) => t.title === 'Regional Science Fair Winner'));
});

test('badges are persisted with a real earnedAt date once earned, and stay earned', async () => {
  await invoke(ctrl.addMyGoal, { user: student, body: { title: 'Goal 1', category: 'other' } });
  const first = await invoke(ctrl.getMyBadges, { user: student });
  const goalSetter = first.body.data.badges.find((b) => b.code === 'goal_setter');
  assert.equal(goalSetter.earned, true);
  assert.ok(goalSetter.earnedAt);

  const stored = await Badge.findOne({ student: student._id, code: 'goal_setter' });
  assert.ok(stored);

  const second = await invoke(ctrl.getMyBadges, { user: student });
  const goalSetter2 = second.body.data.badges.find((b) => b.code === 'goal_setter');
  assert.equal(new Date(goalSetter2.earnedAt).getTime(), stored.earnedAt.getTime(), 'earnedAt does not drift on repeat calls');
});
