const mongoose = require('mongoose');

// A private identity/business document submitted for account verification. The bytes live in
// VerificationDocumentFile (never a public URL); only the owner and verification admins can
// stream them through an authenticated endpoint. Uploading does NOT mean verified.
const verificationDocumentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, required: true },
  documentType: { type: String, required: true },
  file: { type: mongoose.Schema.Types.ObjectId, ref: 'VerificationDocumentFile', required: true },
  originalName: { type: String, default: '', maxlength: 200 },
  contentType: { type: String, required: true },
  size: { type: Number, required: true },
  sha256: { type: String, required: true, index: true },
  uploadStatus: { type: String, enum: ['uploaded'], default: 'uploaded' },
  verificationStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  verifiedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: '' },
  // Replaced documents are kept (not deleted) for the verification history.
  active: { type: Boolean, default: true, index: true },
  replacedAt: { type: Date, default: null }
}, { timestamps: true });

verificationDocumentSchema.index({ user: 1, role: 1, documentType: 1, active: 1 });

module.exports = mongoose.model('VerificationDocument', verificationDocumentSchema);
