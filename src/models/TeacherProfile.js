const mongoose = require('mongoose');

const teacherProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

    institutions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Institution' }],
    subjects: [{ type: String }],
    qualifications: [
      {
        title: String,
        institutionName: String,
        year: Number,
        documentUrl: String
      }
    ],
    experienceYears: { type: Number, default: 0 },
    bio: { type: String, default: '' },
    independent: { type: Boolean, default: false }, // teaches without an institution
    // Lets a teacher opt out of the institution-facing "Find Teachers" directory (still
    // required for the current job-offer flow, since institutions have no other way to
    // discover a teacher's account to send an offer to). Default true so new teachers are
    // actually discoverable.
    visibleToInstitutions: { type: Boolean, default: true },

    status: { type: String, enum: ['active', 'suspended'], default: 'active' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('TeacherProfile', teacherProfileSchema);
