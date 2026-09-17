const mongoose = require('mongoose');
const crypto = require('crypto');

const studentProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    // Digital Student ID (spec Part 10.18 / 15A) — a QR-verifiable code, same pattern as
    // Certificate.verifyCode, so anyone can scan and confirm this is a real enrolled student.
    idCardCode: { type: String, required: true, unique: true, default: () => crypto.randomBytes(8).toString('hex') },

    primaryInstitution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', default: null },
    rollNumber: { type: String, default: '' },
    admissionDate: { type: Date, default: null },
    program: { type: String, default: '' },
    currentTerm: { type: String, default: '' },

    dateOfBirth: { type: Date, default: null },
    guardianContact: { type: String, default: '' },
    // Structured Emergency Contact (spec Part 10.3) — distinct from guardianContact, which is
    // the parent/guardian linking contact number, not necessarily who to call in an emergency.
    emergencyContact: {
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
      relation: { type: String, default: '' }
    },
    // Health Record (spec Part 11.13) — optional, parent-managed, visible only to the parent
    // and authorized institution staff (never public, never shown to other students/parents).
    bloodGroup: { type: String, default: '' },
    allergies: [{ type: String }],
    medicalNotes: { type: String, default: '' },
    vaccinations: [
      { name: String, date: Date, notes: { type: String, default: '' } }
    ],

    // Face-recognition attendance (spec 15B.9/9.9 "Face Recognition") — a 128-number descriptor
    // the student's own browser computes from their profile photo using face-api.js, once, and
    // uploads here. No face image is stored server-side, only these numbers, and matching always
    // happens in the teacher's browser (this app never runs face recognition itself).
    faceDescriptor: { type: [Number], default: null },

    skills: [{ type: String }],
    languages: [{ type: String }],
    interests: [{ type: String }],
    hobbies: [{ type: String }],
    careerGoal: { type: String, default: '' },

    status: { type: String, enum: ['active', 'suspended', 'graduated', 'transferred'], default: 'active' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('StudentProfile', studentProfileSchema);
