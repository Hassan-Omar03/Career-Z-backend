const mongoose = require('mongoose');

// Staff/teacher's own attendance (spec Part 9.9 / 15D.9) — separate from Attendance.js, which is
// students-only (a teacher marking a class). This is the teacher/staff member marking themselves
// present, once per calendar day. Real self-check-in (timestamped), not a claim of biometric
// hardware (fingerprint/face/GPS) this app has no device access to actually implement.
const staffAttendanceSchema = new mongoose.Schema(
  {
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null, index: true },
    date: { type: Date, required: true }, // midnight-normalized, one record per staff per day
    checkInAt: { type: Date, required: true },
    status: { type: String, enum: ['present', 'late'], default: 'present' },
    method: { type: String, enum: ['self_checkin'], default: 'self_checkin' }
  },
  { timestamps: true }
);

staffAttendanceSchema.index({ staff: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('StaffAttendance', staffAttendanceSchema);
