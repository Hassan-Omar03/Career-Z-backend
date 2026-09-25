const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null },
    classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', default: null },
    date: { type: Date, required: true },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    records: [
      {
        student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        status: { type: String, enum: ['present', 'absent', 'late', 'excused'], required: true },
        reason: { type: String, default: '' },
        // How this record was captured (spec: online-only methods for a remote-study platform —
        // no RFID/NFC/physical-fingerprint/retina hardware).
        method: { type: String, enum: ['manual', 'qr', 'face', 'face_remote', 'gps', 'webauthn', 'live'], default: 'manual' },
        checkedInAt: { type: Date, default: Date.now },
        session: { type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceSession', default: null },
        // GPS check-ins record the student's submitted coordinates for audit purposes; never
        // used for anything beyond that one attendance decision.
        location: {
          lat: { type: Number, default: null },
          lng: { type: Number, default: null },
          distanceMeters: { type: Number, default: null }
        }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model('Attendance', attendanceSchema);
