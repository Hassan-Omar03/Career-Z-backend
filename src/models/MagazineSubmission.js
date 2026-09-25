const mongoose = require('mongoose');

// Spec Part "Student Dashboard - #9 Virtual School Magazine": Student submits, Teacher
// selects/edits, Institution publishes, Student + Parent view once published.
const magazineSubmissionSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    type: { type: String, enum: ['article', 'poetry', 'artwork', 'story', 'other'], default: 'other' },
    content: { type: String, required: true },
    imageUrl: { type: String, default: '' },
    status: { type: String, enum: ['submitted', 'changes_requested', 'selected', 'rejected', 'published'], default: 'submitted' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    editorNotes: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('MagazineSubmission', magazineSubmissionSchema);
