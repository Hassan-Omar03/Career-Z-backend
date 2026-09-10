const mongoose = require('mongoose');

// A 1:1 consultation between a Representative and a student — separate from class
// timetables (TimetableEntry), which are academic, not admissions/advising.
const meetingSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    representative: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    relatedInquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Inquiry', default: null },
    relatedApplication: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionApplication', default: null },
    program: { type: String, default: '' },
    scheduledDate: { type: Date, required: true },
    mode: { type: String, enum: ['video', 'audio', 'physical'], default: 'video' },
    location: { type: String, default: '' },
    meetingLink: { type: String, default: '' },
    status: { type: String, enum: ['scheduled', 'completed', 'cancelled'], default: 'scheduled' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Meeting', meetingSchema);
