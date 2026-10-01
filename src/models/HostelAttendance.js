const mongoose = require('mongoose');

// Hostel Attendance (spec gap: "Hostel attendance missing") — one record per room per student
// per night, marked by the warden or institution staff. Separate from academic Attendance.
const hostelAttendanceSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    room: { type: mongoose.Schema.Types.ObjectId, ref: 'HostelRoom', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: String, required: true }, // 'YYYY-MM-DD' — one record per student per calendar day
    status: { type: String, enum: ['present', 'absent', 'on_leave'], required: true },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

hostelAttendanceSchema.index({ room: 1, student: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('HostelAttendance', hostelAttendanceSchema);
