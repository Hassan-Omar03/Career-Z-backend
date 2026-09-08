const mongoose = require('mongoose');

const institutionSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    type: {
      type: String,
      enum: ['school', 'college', 'university', 'academy', 'madrasa', 'tuition_center', 'training_institute', 'online_institute'],
      required: true
    },
    country: { type: String, required: true }, // Country.code
    city: { type: String, default: '' },
    address: { type: String, default: '' },
    logo: { type: String, default: null },
    coverImage: { type: String, default: null },
    description: { type: String, default: '' },
    contactEmail: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    website: { type: String, default: '' },

    verificationStatus: {
      type: String,
      enum: ['pending', 'under_review', 'approved', 'rejected'],
      default: 'pending'
    },
    verificationDocuments: [{ type: String }],

    staff: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        role: { type: String, default: 'staff' }, // e.g. principal, accountant, hr, teacher_coordinator
        permissions: [{ type: String }],
        addedAt: { type: Date, default: Date.now }
      }
    ],

    status: { type: String, enum: ['active', 'suspended', 'disabled'], default: 'active' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Institution', institutionSchema);
