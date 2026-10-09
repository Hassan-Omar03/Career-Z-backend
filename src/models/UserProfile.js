const mongoose = require('mongoose');

// Mandatory profile data, per account type (role). One document per user+role so a person who is
// both a parent and a teacher completes each profile separately. Sensitive identity numbers
// (CNIC / B-Form) are stored encrypted, with only the last 4 digits kept readable.
const userProfileSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, required: true },
  subtype: { type: String, default: '' },
  fields: { type: mongoose.Schema.Types.Mixed, default: {} }, // non-sensitive values by key
  sensitive: { type: mongoose.Schema.Types.Mixed, default: {} }, // key -> { encrypted, last4 }
  completed: { type: Boolean, default: false },
  completedAt: { type: Date, default: null },
  percent: { type: Number, default: 0 }
}, { timestamps: true, minimize: false });

userProfileSchema.index({ user: 1, role: 1 }, { unique: true });

module.exports = mongoose.model('UserProfile', userProfileSchema);
