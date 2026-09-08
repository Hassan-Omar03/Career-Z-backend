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
        status: { type: String, enum: ['present', 'absent', 'late', 'excused'], required: true }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model('Attendance', attendanceSchema);
