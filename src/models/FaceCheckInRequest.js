const mongoose = require('mongoose');

// A remote/online student can't stand in front of the teacher's own camera (see
// teacher.controller.js's markAttendanceByFace, which is physical-classroom-only). This is the
// remote counterpart: the student's own browser captures a live frame, computes a descriptor and
// compares it against their own already-enrolled descriptor (StudentProfile.faceDescriptor) —
// entirely client-side, same as every other face-matching step in this app. The result (a
// distance score, never an image) is submitted here as a pending request; the teacher reviews and
// approves/rejects it before it becomes a real Attendance record, keeping a human in the loop
// since a self-reported client-side score alone could be spoofed.
const faceCheckInRequestSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: Date, required: true },
    distance: { type: Number, required: true }, // euclidean distance, lower = stronger match (same 0.55 threshold used elsewhere)
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('FaceCheckInRequest', faceCheckInRequestSchema);
