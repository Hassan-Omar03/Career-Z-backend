const mongoose = require('mongoose');

// What an approved donor chooses to show publicly. Off by default: a donor appears on the
// homepage and /donors only after switching this on, and only these fields are ever shown
// (never their email, phone, documents, deposits or donation records).
const donorPublicProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    enabled: { type: Boolean, default: false },
    displayName: { type: String, trim: true, maxlength: 120, default: '' },
    about: { type: String, trim: true, maxlength: 1500, default: '' },
    logoUrl: { type: String, default: '', validate: { validator: (v) => !v || /^https:\/\/\S+$/i.test(v), message: 'Use a full https:// link.' } },
    focusAreas: [{ type: String, trim: true, maxlength: 60 }],
    city: { type: String, trim: true, maxlength: 80, default: '' },
    country: { type: String, trim: true, maxlength: 80, default: '' },
    showScholarships: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('DonorPublicProfile', donorPublicProfileSchema);
