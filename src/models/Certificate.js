const mongoose = require('mongoose');
const crypto = require('crypto');

const certificateSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null },
    type: { type: String, enum: ['course', 'diploma', 'training', 'degree', 'achievement'], default: 'course' },
    title: { type: String, required: true },
    academicSession: { type: String, default: '' },
    finalGrade: { type: String, default: '' },
    percentage: { type: Number, default: null },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    revokeReason: { type: String, default: '' },
    issueDate: { type: Date, default: Date.now },
    verifyCode: { type: String, required: true, unique: true, default: () => crypto.randomBytes(8).toString('hex') },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

certificateSchema.index({ student: 1, course: 1, type: 1 }, { unique: true, partialFilterExpression: { course: { $type: 'objectId' } } });

module.exports = mongoose.model('Certificate', certificateSchema);
