const mongoose = require('mongoose');

// Raw bytes of a private verification document, kept apart from the metadata so listings never
// load file contents. Size-capped by the upload endpoint (well under MongoDB's 16 MB limit).
const verificationDocumentFileSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  data: { type: Buffer, required: true }
}, { timestamps: true });

module.exports = mongoose.model('VerificationDocumentFile', verificationDocumentFileSchema);
