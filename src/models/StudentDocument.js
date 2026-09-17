const mongoose = require('mongoose');

// The Student's lifetime Digital Locker (spec Part 10.5) — separate from Certificate, which is
// institution-issued. These are documents the student themselves uploads and owns: IDs, passports,
// experience letters, transcripts, research papers, etc. No file storage service is wired up yet —
// same paste-a-link pattern used everywhere else (User.profilePhoto, Resume.cvFileUrl).
const studentDocumentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ['degree', 'certificate', 'national_id', 'passport', 'student_card', 'experience_letter',
        'recommendation_letter', 'award', 'transcript', 'research_paper', 'project', 'other'],
      default: 'other'
    },
    // Not required: a student can record that a document is expected before they actually have
    // it to upload (status 'pending' + an optional reason), then come back and attach the real
    // file later via PATCH — rather than being blocked from listing it at all until they do.
    fileUrl: { type: String, default: '' },
    status: { type: String, enum: ['available', 'pending'], default: 'available' },
    pendingReason: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('StudentDocument', studentDocumentSchema);
