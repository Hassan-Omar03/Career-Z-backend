const mongoose = require('mongoose');

// A saved search — matches are computed live against open Jobs, nothing is pre-copied here.
const jobAlertSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    keywords: { type: String, default: '' },
    country: { type: String, default: '' },
    city: { type: String, default: '' },
    remoteOnly: { type: Boolean, default: false },
    salaryMin: { type: Number, default: null },
    governmentOnly: { type: Boolean, default: false },
    internationalOnly: { type: Boolean, default: false } // visa-sponsorship jobs — open to candidates abroad
  },
  { timestamps: true }
);

module.exports = mongoose.model('JobAlert', jobAlertSchema);
