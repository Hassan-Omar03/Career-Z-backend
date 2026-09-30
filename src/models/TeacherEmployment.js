const mongoose = require('mongoose');

// The real hiring lifecycle an institution's direct addStaff/removeStaff never had â€” an offer
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
    contractDocumentUrl: { type: String, default: '' },
    salaryType: { type: String, enum: ['monthly', 'commission', 'hybrid'], default: 'monthly' },
    monthlySalary: { type: Number, default: 0, min: 0 },
    salaryCurrency: { type: String, default: 'PKR', trim: true, uppercase: true },
    taxPercent: { type: Number, default: 0, min: 0, max: 100 },
    commissionPercent: { type: Number, default: 0, min: 0, max: 100 },
    leaveRequests: [{ from: Date, to: Date, reason: String, status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }, reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, reviewedAt: { type: Date, default: null } }],
    changes: [{ action: String, fromValue: String, toValue: String, reason: String, changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, changedAt: { type: Date, default: Date.now } }],
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

// One open/active employment record per teacher+institution at a time â€” a past resigned/declined
// one doesn't block a fresh offer later (re-hiring), so the unique index only covers live states.
teacherEmploymentSchema.index(
  { teacher: 1, institution: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['offered', 'active'] } } }
);

module.exports = mongoose.model('TeacherEmployment', teacherEmploymentSchema);
