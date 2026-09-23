const mongoose = require('mongoose');

// Parent-Teacher Meeting (PTM) — distinct from Meeting.js, which is the Institution
// representative <-> prospective-student admissions consultation flow. This is a real
// two-way booking: a parent requests time with their child's actual teacher (verified via
// TimetableEntry), the teacher confirms/reschedules/declines.
const parentTeacherMeetingSchema = new mongoose.Schema(
  {
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    subject: { type: String, default: '' },
    requestedDate: { type: Date, required: true },
    confirmedDate: { type: Date, default: null },
    mode: { type: String, enum: ['video', 'physical'], default: 'video' },
    location: { type: String, default: '' },
    meetingLink: { type: String, default: '' },
    notes: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'confirmed', 'declined', 'completed', 'cancelled'], default: 'pending' },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Set by the teacher when a confirmed meeting's time passed and the parent never showed —
    // the real, explicit signal behind "parent repeatedly misses PTMs" escalation, not a guess.
    noShow: { type: Boolean, default: false },
    // If this meeting was booked into a teacher's recurring slot rather than requested ad-hoc.
    recurringSchedule: { type: mongoose.Schema.Types.ObjectId, ref: 'PtmRecurringSchedule', default: null },
    // Meeting minutes/action items — spec: "PTM ke baad teacher/parent notes aur follow-up
    // tasks likh sakein."
    minutes: { type: String, default: '' },
    minutesUpdatedAt: { type: Date, default: null },
    actionItems: [
      {
        text: { type: String, required: true },
        assignedTo: { type: String, enum: ['parent', 'teacher'], required: true },
        done: { type: Boolean, default: false },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdAt: { type: Date, default: Date.now }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model('ParentTeacherMeeting', parentTeacherMeetingSchema);
