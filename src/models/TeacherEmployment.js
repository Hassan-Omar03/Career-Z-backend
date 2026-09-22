const mongoose = require('mongoose');

// The real hiring lifecycle an institution's direct addStaff/removeStaff never had — an offer
// the teacher actually consents to (or declines), a service record while active, and a
// resignation/termination reason kept as history (spec: Teacher<->Institution "hiring
// application/offer/acceptance, employment contract, resignation, transfer, service history").
const teacherEmploymentSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    role: { type: String, default: 'teacher' },
    designation: { type: String, default: '' },
    department: { type: String, default: '' },
    contractTerms: { type: String, default: '' },
    status: { type: String, enum: ['offered', 'accepted', 'declined', 'active', 'resigned', 'terminated'], default: 'offered' },
    offeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    offeredAt: { type: Date, default: Date.now },
    respondedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    endReason: { type: String, default: '' }
  },
  { timestamps: true }
);

// One open/active employment record per teacher+institution at a time — a past resigned/declined
// one doesn't block a fresh offer later (re-hiring), so the unique index only covers live states.
teacherEmploymentSchema.index(
  { teacher: 1, institution: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['offered', 'active'] } } }
);

module.exports = mongoose.model('TeacherEmployment', teacherEmploymentSchema);
