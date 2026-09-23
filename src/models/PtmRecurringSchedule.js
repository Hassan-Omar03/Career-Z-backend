const mongoose = require('mongoose');

// Spec: "Recurring PTM schedules — teacher ek baar recurring slot set kare, automatically
// repeat ho." No background job scheduler exists in this codebase, so this is a real recurrence
// RULE, not pre-generated ghost meetings — the next N real occurrence dates are computed live
// (ptm.controller.js's computeUpcomingOccurrences) whenever a parent looks at it, and booking
// into one creates one real, normal ParentTeacherMeeting for that exact date.
const ptmRecurringScheduleSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    title: { type: String, required: true, trim: true },
    frequency: { type: String, enum: ['weekly', 'monthly'], required: true },
    dayOfWeek: { type: Number, min: 0, max: 6, default: null }, // 0=Sun..6=Sat, weekly only
    dayOfMonth: { type: Number, min: 1, max: 28, default: null }, // capped at 28 so it always exists
    time: { type: String, required: true }, // "HH:mm", 24h
    mode: { type: String, enum: ['video', 'physical'], default: 'video' },
    meetingLink: { type: String, default: '' },
    location: { type: String, default: '' },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PtmRecurringSchedule', ptmRecurringScheduleSchema);
