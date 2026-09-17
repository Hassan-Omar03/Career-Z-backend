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
    status: { type: String, enum: ['pending', 'confirmed', 'declined', 'completed', 'cancelled'], default: 'pending' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ParentTeacherMeeting', parentTeacherMeetingSchema);
