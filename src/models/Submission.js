const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema(
  {
    assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    text: { type: String, default: '' },
    attachments: [{ name: String, url: String }],
    submittedAt: { type: Date, default: Date.now },

    marksObtained: { type: Number, default: null },
    feedback: { type: String, default: '' },
    gradedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    gradedAt: { type: Date, default: null },

    status: { type: String, enum: ['submitted', 'graded', 'resubmit_requested'], default: 'submitted' }
  },
  { timestamps: true }
);

submissionSchema.index({ assignment: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('Submission', submissionSchema);
