const mongoose = require('mongoose');

const scholarshipSchema = new mongoose.Schema(
  {
    // The funder who decides applications. Null for an agent listing of an outside provider.
    donor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'PKR' },
    eligibilityCriteria: { type: String, default: '' },
    country: { type: String, default: '' },
    applicationDeadline: { type: Date },
    seatsAvailable: { type: Number, default: 1, min: 0 },
    seatRevision: { type: Number, default: 0 },
    status: { type: String, enum: ['open', 'closed', 'pending_review', 'rejected'], default: 'open' },
    // Who the scholarship is for; teachers only get alerts when the publisher includes them.
    audience: { type: [{ type: String, enum: ['students', 'teachers'] }], default: ['students'] },
    publishedAt: { type: Date, default: null },
    // Agent listings (see agentScholarship.controller): who listed it for which provider. The agent
    // never awards or funds; 'external' listings link to the provider's own application page.
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    provider: {
      type: { type: String, enum: ['', 'careerz_donor', 'university', 'government', 'foundation', 'company', 'other'], default: '' },
      name: { type: String, default: '' }, website: { type: String, default: '' }, country: { type: String, default: '' },
      authorization: { type: String, default: '' },
      donor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
    },
    applicationMode: { type: String, enum: ['internal', 'external'], default: 'internal' },
    externalUrl: { type: String, default: '' },
    review: {
      status: { type: String, enum: ['', 'awaiting_donor', 'pending', 'approved', 'rejected'], default: '' },
      note: { type: String, default: '' }, donorConfirmedAt: Date,
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, reviewedAt: Date
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Scholarship', scholarshipSchema);
