const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { DEFAULT_ROLES, getPermissionsForRoles } = require('../config/rbac');

const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    passwordHash: { type: String, required: true },

    roles: { type: [String], default: DEFAULT_ROLES },

    country: { type: String, default: null }, // Country.code
    language: { type: String, default: 'en' }, // Language.code
    currency: { type: String, default: null }, // Currency.code

    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },

    status: { type: String, enum: ['active', 'suspended', 'disabled'], default: 'active' },

    twoFactorEnabled: { type: Boolean, default: false },

    profilePhoto: { type: String, default: null },
    companyName: { type: String, default: '' }, // Employer/Agent's agency name, or Donor's org name
    donorType: { type: String, enum: ['individual', 'organization', ''], default: '' },

    lastLoginAt: { type: Date, default: null },

    savedJobs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Job' }],
    savedFundingRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FundingRequest' }],

    // "Recently viewed jobs" for the job-seeker dashboard — capped, most-recent-first.
    recentlyViewedJobs: [
      {
        job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
        viewedAt: { type: Date, default: Date.now }
      }
    ]
  },
  { timestamps: true }
);

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.methods.permissions = function () {
  return getPermissionsForRoles(this.roles);
};

userSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  return obj;
};

userSchema.statics.hashPassword = function (plain) {
  return bcrypt.hash(plain, 10);
};

module.exports = mongoose.model('User', userSchema);
