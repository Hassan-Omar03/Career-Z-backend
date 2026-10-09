const mongoose = require('mongoose');

// An institution's own grading scale. Results, transcripts and GPA/CGPA all use it; an
// institution without one gets DEFAULT_BANDS (the platform's original 4.0 scale).
const bandSchema = new mongoose.Schema({
  minPercent: { type: Number, required: true, min: 0, max: 100 },
  grade: { type: String, required: true, trim: true, maxlength: 8 },
  points: { type: Number, required: true, min: 0 }
}, { _id: false });

const gradingPolicySchema = new mongoose.Schema({
  institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, unique: true },
  gpaScaleMax: { type: Number, enum: [4, 5, 10], default: 4 },
  passingPercent: { type: Number, min: 0, max: 100, default: 50 },
  // Highest band first; the first band whose minPercent the score reaches applies.
  bands: { type: [bandSchema], default: undefined },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

module.exports = mongoose.model('GradingPolicy', gradingPolicySchema);
