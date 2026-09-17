const mongoose = require('mongoose');

// Borrowing / return / fine tracking (spec 15D.10).
const libraryLoanSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    book: { type: mongoose.Schema.Types.ObjectId, ref: 'LibraryBook', required: true, index: true },
    borrower: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    borrowedAt: { type: Date, default: Date.now },
    dueDate: { type: Date, required: true },
    returnedAt: { type: Date, default: null },
    status: { type: String, enum: ['borrowed', 'returned', 'overdue'], default: 'borrowed' },
    finePerDay: { type: Number, default: 0 },
    fineAmount: { type: Number, default: 0 },
    fineWaived: { type: Boolean, default: false },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('LibraryLoan', libraryLoanSchema);
