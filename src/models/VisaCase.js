const mongoose = require('mongoose');

// Master 13.7 Visa Case Tracking: one candidate's visa journey for one job abroad. The hiring
// side (employer or agent) and an assigned verified visa consultant move it through the stages;
// the candidate follows it and uploads documents. CareerZ only tracks: governments decide.
const STAGES = ['documents_submitted', 'employer_verified', 'agency_verified', 'interview_completed', 'offer_letter_received', 'visa_processing', 'visa_approved', 'travel_completed'];

const visaCaseSchema = new mongoose.Schema(
  {
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    application: { type: mongoose.Schema.Types.ObjectId, ref: 'JobApplication', required: true, unique: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true },
    hiringSide: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    consultant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    destination: { type: String, required: true, uppercase: true },
    visaType: { type: String, default: '' },
    stages: [{ key: { type: String, enum: STAGES }, done: { type: Boolean, default: false }, at: { type: Date, default: null }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, note: { type: String, default: '' }, _id: false }],
    documents: [{ name: String, file: { type: mongoose.Schema.Types.ObjectId, ref: 'PrivateFile' }, at: { type: Date, default: Date.now }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, _id: false }],
    status: { type: String, enum: ['active', 'approved', 'refused', 'closed'], default: 'active', index: true },
    history: [{ text: String, at: { type: Date, default: Date.now }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, _id: false }]
  },
  { timestamps: true }
);

module.exports = mongoose.model('VisaCase', visaCaseSchema);
module.exports.STAGES = STAGES;
