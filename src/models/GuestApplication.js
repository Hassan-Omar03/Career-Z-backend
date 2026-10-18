const mongoose = require('mongoose');

// A job application from someone without a CareerZ account. The emailed tracking link is the
// guest's only key: opening it proves the email address (only then does the hiring side see the
// application) and shows the status. Stored values follow JobApplication's hiring stages. Kept
// only for a limited time (see guestApplication.service cleanup), CV included.
const guestApplicationSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 160 },
    phone: { type: String, default: '', maxlength: 40 },
    city: { type: String, default: '', maxlength: 80 },
    coverLetter: { type: String, default: '', maxlength: 4000 },
    cv: { type: mongoose.Schema.Types.ObjectId, ref: 'PrivateFile', required: true },
    trackingTokenHash: { type: String, required: true, unique: true },
    emailVerified: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: null },
    consentAt: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'viewed', 'shortlisted', 'interview', 'final_interview', 'selected', 'accepted', 'hired', 'completed', 'rejected', 'withdrawn'], default: 'pending' },
    statusHistory: [{ status: String, at: { type: Date, default: Date.now }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, byRole: String, note: String, _id: false }],
    joining: {
      confirmed: { type: Boolean, default: false },
      confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      confirmedAt: { type: Date, default: null },
      via: { type: String, enum: ['', 'hiring_organization', 'candidate'], default: '' }
    },
    ip: { type: String, default: '' }
  },
  { timestamps: true }
);
guestApplicationSchema.index({ job: 1, email: 1 });

module.exports = mongoose.model('GuestApplication', guestApplicationSchema);
