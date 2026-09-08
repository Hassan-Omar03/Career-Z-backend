const mongoose = require('mongoose');

const feeSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    title: { type: String, required: true }, // e.g. "Tuition Fee - Term 1"
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    dueDate: { type: Date, default: null },
    status: { type: String, enum: ['pending', 'paid', 'overdue'], default: 'pending' },
    paidAt: { type: Date, default: null },
    paidVia: { type: String, default: '' }, // e.g. "Bank Transfer", "Cash", "External Link" - real payment gateways are a later phase
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Fee', feeSchema);
