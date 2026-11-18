const mongoose = require('mongoose');

// A message sent from the public Contact page (audit point 1). Admins are notified by email and in
// the app; the record keeps the enquiry so it can be answered and audited later.
const contactMessageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    phone: { type: String, default: '', trim: true, maxlength: 40 },
    organization: { type: String, default: '', trim: true, maxlength: 160 },
    enquiryType: { type: String, enum: ['support', 'partnership', 'institution', 'advertising', 'media', 'other'], default: 'support' },
    message: { type: String, required: true, trim: true, maxlength: 4000 },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    ip: { type: String, default: '' },
    status: { type: String, enum: ['new', 'answered', 'closed'], default: 'new', index: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ContactMessage', contactMessageSchema);
