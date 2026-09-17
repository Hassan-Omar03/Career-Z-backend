const mongoose = require('mongoose');

// Events & Activities (spec 15D.17) — sports day, annual function, seminars, workshops,
// competitions, parent meetings, convocation.
const institutionEventSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    title: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['sports_day', 'annual_function', 'seminar', 'workshop', 'competition', 'parent_meeting', 'convocation', 'other'],
      default: 'other'
    },
    description: { type: String, default: '' },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    venue: { type: String, default: '' },
    audience: [{ type: String, enum: ['students', 'parents', 'teachers', 'staff'] }],
    coverImage: { type: String, default: '' },
    rsvps: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, respondedAt: { type: Date, default: Date.now } }],
    status: { type: String, enum: ['upcoming', 'ongoing', 'completed', 'cancelled'], default: 'upcoming' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('InstitutionEvent', institutionEventSchema);
