const mongoose = require('mongoose');
const crypto = require('crypto');

// A short-lived, teacher-generated QR check-in session — the QR itself encodes only this
// session's one-time token, never a student's permanent Digital ID. Students scan it with their
// own device; the token expires after a few minutes so an old/screenshotted QR can't be reused
// once the session closes (spec: "session/time-based QR mechanism").
const attendanceSessionSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, required: true },
    token: { type: String, required: true, unique: true, default: () => crypto.randomBytes(16).toString('hex') },
    expiresAt: { type: Date, required: true },
    checkedIn: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
  },
  { timestamps: true }
);

module.exports = mongoose.model('AttendanceSession', attendanceSessionSchema);
