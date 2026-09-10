const mongoose = require('mongoose');

// A prospective student's interest in an institution — the lead a Representative works.
const inquirySchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    interestedProgram: { type: String, required: true },
    qualification: { type: String, default: '' },
    country: { type: String, default: '' },
    message: { type: String, default: '' },
    status: { type: String, enum: ['new', 'contacted', 'follow_up', 'resolved', 'closed'], default: 'new' },
    assignedRepresentative: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    responses: [
      {
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        text: String,
        createdAt: { type: Date, default: Date.now }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model('Inquiry', inquirySchema);
