const mongoose = require('mongoose');

// Invoice for a recruitment fee under an accepted agreement. Paid by manual bank transfer: the
// institute uploads proof and a reference, an admin verifies the money actually arrived, and only
// then is the agent's earning released. Every step is kept in `history`.

const invoiceSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    agreement: { type: mongoose.Schema.Types.ObjectId, ref: 'RecruitmentAgreement', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    commission: { type: mongoose.Schema.Types.ObjectId, ref: 'Commission', required: true },
    description: { type: String, default: '' },
    currency: { type: String, required: true },
    grossFee: { type: Number, required: true, min: 0 },          // what the institute pays
    platformFee: { type: Number, required: true, min: 0 },       // CareerZ service fee (Super Admin %)
    processingCharges: { type: Number, required: true, min: 0 },
    agentEarning: { type: Number, required: true, min: 0 },
    issuedAt: { type: Date, default: Date.now },
    dueDate: { type: Date, required: true },
    status: { type: String, enum: ['issued', 'pending_verification', 'more_info_requested', 'paid', 'cancelled'], default: 'issued', index: true },
    proofs: [{
      file: { type: mongoose.Schema.Types.ObjectId, ref: 'PrivateFile', default: null },
      reference: { type: String, maxlength: 120 }, amount: Number, paidOn: Date,
      submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, submittedAt: { type: Date, default: Date.now }
    }],
    history: [{ action: String, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, note: String, at: { type: Date, default: Date.now }, _id: false }],
    // Replacement / refund handling under the agreement's own terms (never automatic).
    replacement: {
      status: { type: String, enum: ['', 'awaiting_replacement', 'replaced', 'refund_review', 'refunded', 'adjusted', 'dismissed'], default: '' },
      reportedAt: Date, reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, reason: String,
      deadline: Date, attemptsUsed: { type: Number, default: 0 }, resolutionNote: String,
      resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, resolvedAt: Date
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('RecruitmentInvoice', invoiceSchema);
