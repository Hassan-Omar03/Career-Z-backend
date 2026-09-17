const mongoose = require('mongoose');

// Hostel visitor log + student leave requests (spec 15D.11) — kept as one model since both are
// simple, warden-reviewed records tied to a resident student.
const hostelRequestSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    room: { type: mongoose.Schema.Types.ObjectId, ref: 'HostelRoom', required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['visitor', 'leave'], required: true },
    // visitor fields
    visitorName: { type: String, default: '' },
    visitorRelation: { type: String, default: '' },
    visitDate: { type: Date, default: null },
    // leave fields
    fromDate: { type: Date, default: null },
    toDate: { type: Date, default: null },
    reason: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('HostelRequest', hostelRequestSchema);
