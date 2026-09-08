const mongoose = require('mongoose');

const scholarshipSchema = new mongoose.Schema(
  {
    donor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    eligibilityCriteria: { type: String, default: '' },
    country: { type: String, default: '' },
    applicationDeadline: { type: Date },
    seatsAvailable: { type: Number, default: 1, min: 0 },
    status: { type: String, enum: ['open', 'closed'], default: 'open' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Scholarship', scholarshipSchema);
