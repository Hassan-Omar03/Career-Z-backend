const mongoose = require('mongoose');

const courseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    studyMode: { type: String, enum: ['online','physical','hybrid','recorded','self_paced','ai'], default: 'online' },
    approvalWorkflow: { type: String, enum: ['direct','staged'], default: 'direct' },
    offlineDownloadAllowed: {type:Boolean,default:true},
    copyrightNotice: {type:String,default:''},
    contentLicense: {type:String,enum:['internal','copyright','creative_commons','commercial'],default:'internal'},
    courseCode: String, duration: String, category: String, tags: [String], coverImage: String,
    description: { type: String, default: '' },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', default: null },

    subject: { type: String, default: '' },
    creditHours: { type: Number, min: 0.5, max: 12, default: 3 },
    academicTerm: { type: String, default: '' },
    level: { type: String, default: '' },
    language: { type: String, default: 'en' },

    price: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    isFree: { type: Boolean, default: true },

    thumbnail: { type: String, default: null },
    published: { type: Boolean, default: false },

    certificateEnabled: { type: Boolean, default: false },

    // Institution/teacher-level kill switch for Study Groups on this course (spec: "Institute
    // ka enable/disable control"). Defaults on; a teacher flips this off per class if unwanted.
    studyGroupsEnabled: { type: Boolean, default: true },

    // Explicit marker for records created by automated tests/verification scripts, not real
    // product data. Public listings must always exclude these — never rely on matching a title
    // string, which is easy to forget to update and easy for a real course to collide with.
    testOnly: { type: Boolean, default: false },

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

require('../utils/contentVersioning')(courseSchema,'course');
module.exports = mongoose.model('Course', courseSchema);
