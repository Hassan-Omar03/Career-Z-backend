const mongoose = require('mongoose');

// Institute → Agent recruitment request (proposed extension, client-approved direction): a private
// hiring requirement an institute sends to one verified agent. It is never a public job; the
// agent publishes jobs only after both sides accept a RecruitmentAgreement.

const positionSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  category: { type: String, default: 'other' },
  vacancies: { type: Number, required: true, min: 1, max: 500 },
  qualifications: { type: String, default: '', maxlength: 1000 },
  experienceYears: { type: Number, default: 0, min: 0, max: 50 },
  salaryMin: { type: Number, default: null, min: 0 },
  salaryMax: { type: Number, default: null, min: 0 },
  currency: { type: String, default: 'PKR', uppercase: true, trim: true },
  employmentType: { type: String, enum: ['full_time', 'part_time', 'internship', 'freelance', 'government', 'ngo'], default: 'full_time' },
  responsibilities: { type: String, default: '', maxlength: 2000 }
}, { _id: true });

const recruitmentRequestSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    positions: { type: [positionSchema], validate: [(v) => v.length > 0 && v.length <= 20, 'Add 1 to 20 positions.'] },
    city: { type: String, default: '' },
    country: { type: String, default: '' },
    hiringDeadline: { type: Date, default: null },
    specialRequirements: { type: String, default: '', maxlength: 2000 },
    // The institute's opening proposal for the fee; the binding terms live in the agreement.
    proposedFee: { type: String, default: '', maxlength: 500 },
    status: { type: String, enum: ['sent', 'clarification_requested', 'accepted', 'rejected', 'agreed', 'cancelled', 'completed'], default: 'sent', index: true },
    messages: [{ by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, side: { type: String, enum: ['institution', 'agent'] }, text: { type: String, maxlength: 2000 }, at: { type: Date, default: Date.now } }],
    activeAgreement: { type: mongoose.Schema.Types.ObjectId, ref: 'RecruitmentAgreement', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('RecruitmentRequest', recruitmentRequestSchema);
