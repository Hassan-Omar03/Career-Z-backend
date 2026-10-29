const mongoose = require('mongoose');

// A small private file kept in the database (payment proofs, guest CVs). Never public: it is
// served only through endpoints that check who is asking.
const privateFileSchema = new mongoose.Schema(
  {
    purpose: { type: String, enum: ['payment_proof', 'guest_cv', 'resume_cv', 'offer_letter', 'scholarship_document', 'funding_document', 'digital_product', 'dispute_evidence', 'visa_document'], required: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    filename: { type: String, required: true, maxlength: 160 },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PrivateFile', privateFileSchema);
