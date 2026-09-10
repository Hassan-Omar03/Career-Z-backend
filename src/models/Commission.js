const mongoose = require('mongoose');

// Earned automatically when a candidate an education_agent placed (via their own job
// posting) is marked "hired" — a real, computed ledger entry, not a manual/fabricated one.
const commissionSchema = new mongoose.Schema(
  {
    agent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true },
    application: { type: mongoose.Schema.Types.ObjectId, ref: 'JobApplication', required: true, unique: true },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rate: { type: Number, default: 10 }, // percentage of salaryMin used to compute amount
    amount: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    // pending: just earned, awaiting review -> approved: reviewed, confirmed legitimate
    // -> available: cleared for withdrawal -> paid: included in a completed withdrawal.
    // cancelled: the underlying hire fell through (application status moved off "hired").
    status: { type: String, enum: ['pending', 'approved', 'available', 'paid', 'cancelled'], default: 'pending' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Commission', commissionSchema);
