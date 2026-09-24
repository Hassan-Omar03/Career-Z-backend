const mongoose = require('mongoose');

const courseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', default: null },

    subject: { type: String, default: '' },
    level: { type: String, default: '' },
    language: { type: String, default: 'en' },

    price: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    isFree: { type: Boolean, default: true },

    thumbnail: { type: String, default: null },
    published: { type: Boolean, default: false },

    certificateEnabled: { type: Boolean, default: false },

    // GPS/location attendance (spec: optional — browser/device location permission required).
    // When set, a student's GPS attendance check-in is only accepted inside this radius.
    attendanceLocation: {
      enabled: { type: Boolean, default: false },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      radiusMeters: { type: Number, default: 150 }
    },

    // How "course completed" is actually decided for this course (utils/courseProgress.js).
    // Weights only apply to the categories that have real items in this course (e.g. a course
    // with no assignments never penalizes a student for that — its weight is redistributed
    // across the categories that do apply). Weights should sum to 100; enforced in the controller.
    completionRules: {
      weights: {
        lessons: { type: Number, default: 40 },
        assignments: { type: Number, default: 20 },
        tests: { type: Number, default: 25 },
        attendance: { type: Number, default: 15 }
      },
      // Hard gate, separate from the weighted score — 0 disables it.
      minAttendancePercent: { type: Number, default: 0 },
      // If true, hitting 100% only moves a student to "pending_approval"; a teacher must
      // explicitly approve before status becomes "completed".
      requireTeacherApproval: { type: Boolean, default: false }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Course', courseSchema);
