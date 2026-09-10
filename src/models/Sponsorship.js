const mongoose = require('mongoose');

// A real, individual funding commitment — created automatically when a donor approves a
// ScholarshipApplication. amount = the scholarship's total pool split across its seats.
const sponsorshipSchema = new mongoose.Schema(
  {
    donor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    scholarship: { type: mongoose.Schema.Types.ObjectId, ref: 'Scholarship', required: true },
    application: { type: mongoose.Schema.Types.ObjectId, ref: 'ScholarshipApplication', required: true, unique: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, default: 0 }, // total committed amount
    paidAmount: { type: Number, default: 0 }, // donor-confirmed payments made so far (no real payment processor)
    nextPaymentDate: { type: Date, default: null },
    currency: { type: String, default: 'USD' },
    // pending: approved, funds not yet disbursed -> active: disbursed, ongoing -> paused: temporarily
    // on hold -> completed: sponsorship period finished -> cancelled: fell through
    status: { type: String, enum: ['pending', 'active', 'paused', 'completed', 'cancelled'], default: 'pending' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Sponsorship', sponsorshipSchema);
