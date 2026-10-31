const mongoose = require('mongoose');

// An institute's email invitation to a teacher, a staff member or a student. The email carries a
// one-time link (only its hash is stored). Whoever opens it creates their CareerZ account (or signs
// in with the same email) and joins the institute at once; the institute vouches for them, so no
// separate document check is needed for this work.
const institutionInviteSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    name: { type: String, default: '', trim: true },
    kind: { type: String, enum: ['teacher', 'staff', 'student'], required: true },
    role: { type: String, default: '' }, // staff role key (principal, accountant…); 'teacher' for teachers
    designation: { type: String, default: '' },
    department: { type: String, default: '' },
    program: { type: String, default: '' }, // students
    classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', default: null }, // students
    message: { type: String, default: '' },
    tokenHash: { type: String, required: true, unique: true, select: false },
    status: { type: String, enum: ['sent', 'accepted', 'declined', 'cancelled', 'expired'], default: 'sent', index: true },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    newAccount: { type: Boolean, default: false },
    sentCount: { type: Number, default: 1 },
    lastSentAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null }
  },
  { timestamps: true }
);
institutionInviteSchema.index({ institution: 1, email: 1, kind: 1, status: 1 });

module.exports = mongoose.model('InstitutionInvite', institutionInviteSchema);
