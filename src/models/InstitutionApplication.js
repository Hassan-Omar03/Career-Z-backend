const mongoose = require('mongoose');

// A real admissions application workflow — distinct from StudentProfile.primaryInstitution
// (the instant "connect to institution" used once a student is already enrolled). This is
// the pre-enrollment pipeline a Representative works: submit, review, request documents, decide.
const institutionApplicationSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    applicant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    program: { type: String, required: true },
    feePlanSnapshot: {
      department: { type: String, default: '' },
      durationTerms: { type: Number, default: null },
      admissionFee: { type: Number, default: null },
      totalTuitionFee: { type: Number, default: null },
      installments: { type: Number, default: null },
      currency: { type: String, default: '' },
      additionalFees: {
        exam: { enabled: { type: Boolean, default: false }, amount: { type: Number, default: 0 } },
        hostel: { enabled: { type: Boolean, default: false }, amount: { type: Number, default: 0 } },
        transport: { enabled: { type: Boolean, default: false }, amount: { type: Number, default: 0 } },
        library: { enabled: { type: Boolean, default: false }, amount: { type: Number, default: 0 } },
        activity: { enabled: { type: Boolean, default: false }, amount: { type: Number, default: 0 } }
      },
      capturedAt: { type: Date, default: null }
    },
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

    // Admission Test (spec 15D.3). Two ways this gets used:
    // 1) External/physical test — institution just schedules a date/subject and later types in
    //    `score`/`maxScore` by hand (the test itself happens outside CareerZ).
    // 2) Real online test — institution assigns a reusable `AdmissionTest` (see `test` ref) and
    //    the applicant takes it inside the platform; `status`/`startedAt`/`submittedAt`/`answers`
    //    below track that one attempt. No background scheduler exists in this codebase, so the
    //    hard deadline (startedAt + test.durationMinutes) is enforced on read/submit, not a live timer.
    admissionTest: {
      test: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionTest', default: null },
      scheduledAt: { type: Date, default: null },
      subject: { type: String, default: '' },
      maxScore: { type: Number, default: null },
      score: { type: Number, default: null }, // manual entry path (external test)
      notes: { type: String, default: '' },
      status: { type: String, enum: ['not_assigned', 'scheduled', 'in_progress', 'submitted', 'passed', 'failed'], default: 'not_assigned' },
      startedAt: { type: Date, default: null },
      submittedAt: { type: Date, default: null },
      answers: [{ questionIndex: Number, selectedOption: Number }]
    },
    // Interview Scheduling (spec 15D.3)
    interview: {
      scheduledAt: { type: Date, default: null },
      mode: { type: String, enum: ['in_person', 'video', 'phone', ''], default: '' },
      meetingLink: { type: String, default: '' }, // shown to the applicant when mode is 'video'
      location: { type: String, default: '' }, // shown to the applicant when mode is 'in_person'
      interviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      completed: { type: Boolean, default: false },
      recommendation: { type: String, enum: ['pass', 'reject', 'waitlist', ''], default: '' },
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
