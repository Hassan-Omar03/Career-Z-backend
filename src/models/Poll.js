const mongoose = require('mongoose');

// Spec Part "Student Dashboard - #18 Quick Poll": Teacher/Institution create, Student answers.
const pollSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', default: null },
    question: { type: String, required: true },
    options: [
      {
        text: { type: String, required: true },
        votes: { type: Number, default: 0 }
      }
    ],
    votedBy: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        optionIndex: Number
      }
    ],
    status: { type: String, enum: ['open', 'closed'], default: 'open' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Poll', pollSchema);
