const mongoose = require('mongoose');

const studentProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

    primaryInstitution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', default: null },
    rollNumber: { type: String, default: '' },
    admissionDate: { type: Date, default: null },

    dateOfBirth: { type: Date, default: null },
    guardianContact: { type: String, default: '' },
    skills: [{ type: String }],
    languages: [{ type: String }],
    careerGoal: { type: String, default: '' },

    status: { type: String, enum: ['active', 'suspended', 'graduated', 'transferred'], default: 'active' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('StudentProfile', studentProfileSchema);
