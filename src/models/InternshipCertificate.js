const mongoose = require('mongoose');
const crypto = require('crypto');

// Internship completion certificate, issued either by the employer who hired the student for an
// internship job, or by the student's institution (placement office). Verifiable by QR/code.
const schema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    issuerType: { type: String, enum: ['employer', 'institution'], required: true },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
    application: { type: mongoose.Schema.Types.ObjectId, ref: 'JobApplication', default: null },
    organization: { type: String, required: true, trim: true, maxlength: 160 },
    role: { type: String, required: true, trim: true, maxlength: 160 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    hours: { type: Number, default: null, min: 0, max: 5000 },
    skills: [{ type: String, trim: true, maxlength: 60 }],
    remarks: { type: String, default: '', maxlength: 1000 },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, default: '' },
    verifyCode: { type: String, required: true, unique: true, default: () => crypto.randomBytes(8).toString('hex') }
  },
  { timestamps: true }
);
// One active certificate per hired internship application.
schema.index({ application: 1 }, { unique: true, partialFilterExpression: { application: { $type: 'objectId' }, status: 'active' } });

module.exports = mongoose.model('InternshipCertificate', schema);
