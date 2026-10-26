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
    admissionRequirements: { type: String, default: '' },
    admissionDeadline: { type: Date, default: null },

    verificationStatus: {
      type: String,
      enum: ['pending', 'under_review', 'approved', 'rejected'],
      default: 'pending'
    },
    verificationDocuments: [{ type: String }],

    staff: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        role: { type: String, default: 'staff' }, // routing key — must be an exact value like 'representative'/'teacher' for workspace access
        designation: { type: String, default: '' }, // free-text job title shown on the dashboard, e.g. "Senior Admissions Officer"
        department: { type: String, default: '' },
        permissions: [{ type: String }],
        addedAt: { type: Date, default: Date.now }
      }
    ],

    // Public profile extras (validated in utils/institutionProfile.js).
    accreditations: [{ body: String, reference: String, validUntil: Date, documentUrl: String, _id: false }],
    affiliations: [{ name: String, kind: { type: String, default: 'other' }, since: Number, _id: false }],
    socialLinks: { facebook: String, instagram: String, linkedin: String, x: String, youtube: String, tiktok: String, whatsapp: String },
    location: { lat: { type: Number, default: null }, lng: { type: Number, default: null } },

    status: { type: String, enum: ['active', 'suspended', 'disabled'], default: 'active' },

    // Master spec Part 17E "Subscription System" — every institution starts on Free; paid tiers
    // are 30-day purchases via JazzCash (see subscription.controller.js), not true recurring
    // billing yet. A lapsed paid plan just falls back to Free-tier limits (see subscriptionGate.js).
    subscription: {
      plan: { type: String, enum: ['free', 'basic', 'professional', 'enterprise'], default: 'free' },
      status: { type: String, enum: ['active', 'expired'], default: 'active' },
      currentPeriodEnd: { type: Date, default: null },
      paddleTransactionId: { type: String, default: null }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Institution', institutionSchema);
