const mongoose = require('mongoose');

// An institution's virtual career/education fair "booth" — the video call itself is an
// external link (Zoom/Meet/Teams), same honest pattern as class meetingLinks: CareerZ
// doesn't host video, it just organizes who's registered and where to join.
const virtualFairSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    scheduledDate: { type: Date, required: true },
    videoCallLink: { type: String, default: '' },
    brochureUrl: { type: String, default: '' },
    registeredStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    status: { type: String, enum: ['upcoming', 'live', 'ended'], default: 'upcoming' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('VirtualFair', virtualFairSchema);
