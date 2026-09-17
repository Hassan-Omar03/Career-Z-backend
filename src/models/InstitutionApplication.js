const mongoose = require('mongoose');

// A real admissions application workflow — distinct from StudentProfile.primaryInstitution
// (the instant "connect to institution" used once a student is already enrolled). This is
// the pre-enrollment pipeline a Representative works: submit, review, request documents, decide.
const institutionApplicationSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    applicant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    program: { type: String, required: true },
    status: {
      type: String,
      enum: ['draft', 'submitted', 'under_review', 'documents_required', 'waitlisted', 'accepted', 'rejected'],
      default: 'draft'
    },
    documents: [
      {
        name: String,
        url: String,
        status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }
      }
    ],
    missingRequirements: [{ type: String }],
    assignedRepresentative: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    notes: { type: String, default: '' },
    submittedAt: { type: Date, default: null },
    source: { type: String, enum: ['self', 'front_desk'], default: 'self' }, // spec 15D.3: online (self) vs offline/front-desk entry

    // Admission Test (spec 15D.3)
    admissionTest: {
      scheduledAt: { type: Date, default: null },
      subject: { type: String, default: '' },
      maxScore: { type: Number, default: null },
      score: { type: Number, default: null },
      notes: { type: String, default: '' }
    },
    // Interview Scheduling (spec 15D.3)
    interview: {
      scheduledAt: { type: Date, default: null },
      mode: { type: String, enum: ['in_person', 'video', 'phone', ''], default: '' },
      interviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      completed: { type: Boolean, default: false },
      notes: { type: String, default: '' }
    },
    // Admission Letter + Student ID (spec 15D.3) — generated once accepted, same verify-code
    // pattern as Certificate.verifyCode so the letter is independently checkable.
    admissionLetter: {
      verifyCode: { type: String, default: null },
      issuedAt: { type: Date, default: null }
    },
    generatedStudentProfile: { type: mongoose.Schema.Types.ObjectId, ref: 'StudentProfile', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('InstitutionApplication', institutionApplicationSchema);
