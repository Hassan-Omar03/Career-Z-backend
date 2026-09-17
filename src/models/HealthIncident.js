const mongoose = require('mongoose');

// Emergency/medical incident log (spec 15D.14) — a real event record (fell in playground, fever
// sent home, etc.), distinct from the static bloodGroup/allergies/vaccinations on StudentProfile.
const healthIncidentSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    occurredAt: { type: Date, default: Date.now },
    description: { type: String, required: true },
    actionTaken: { type: String, default: '' },
    severity: { type: String, enum: ['minor', 'moderate', 'severe'], default: 'minor' },
    parentNotified: { type: Boolean, default: false },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('HealthIncident', healthIncidentSchema);
