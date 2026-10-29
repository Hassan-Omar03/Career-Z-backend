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
    city: { type: String, default: null },
    termsAcceptedAt: { type: Date, default: null }, // Terms & Conditions + Privacy Policy accepted at signup
    language: { type: String, default: 'en' }, // Language.code
    currency: { type: String, default: null }, // Currency.code

    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },

    status: { type: String, enum: ['active', 'suspended', 'disabled', 'deleted'], default: 'active' },
    deletedAt: { type: Date, default: null },

    twoFactorEnabled: { type: Boolean, default: false },

    profilePhoto: { type: String, default: null }, // also doubles as a Marketplace Seller's store logo
    coverImage: { type: String, default: null }, // profile cover banner (spec Part 10.3)
    companyName: { type: String, default: '' }, // Employer/Agent's agency name, Donor's org name, or Seller's store name
    donorType: { type: String, enum: ['individual', 'organization', ''], default: '' },
    storeStatus: { type: String, enum: ['open', 'closed'], default: 'open' }, // Marketplace Seller's own open/closed toggle

    lastLoginAt: { type: Date, default: null },

    savedJobs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Job' }],
    savedFundingRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FundingRequest' }],

    // "Recently viewed jobs" for the job-seeker dashboard — capped, most-recent-first.
    recentlyViewedJobs: [
      {
        job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
        viewedAt: { type: Date, default: Date.now }
      }
    ],

    // Notification Center (Master 35) and Job Alerts (Job Marketplace 19): what the person wants
    // to receive, and where. Everything is on until they switch it off or unsubscribe.
    notificationPreferences: {
      jobAlertsInApp: { type: Boolean, default: true },
      jobAlertsEmail: { type: Boolean, default: true },
      weeklyDigest: { type: Boolean, default: true },
      applicationEmails: { type: Boolean, default: true },
      scholarshipAlertsInApp: { type: Boolean, default: true },
      scholarshipAlertsEmail: { type: Boolean, default: true }
    },
    // Profile-based job matching beyond the CV: categories and places the person wants.
    jobPreferences: {
      categories: [{ type: String }],
      cities: [{ type: String }],
      remoteOk: { type: Boolean, default: false }
    },
    // Secret used in one-click unsubscribe links in alert emails (no login needed).
    unsubscribeToken: { type: String, default: null, index: { sparse: true } },
    // Public recruitment profile institutes see in Find Agents (agents only).
    // Super Admin sanctions on an agent (master: job-posting ban, agent licence cancellation).
    // Made by marketplace quick checkout (no account type); can order, pay and track orders.
    quickBuyer: { type: Boolean, default: false },
    // The last delivery details a buyer used, offered again on the next order.
    shippingProfile: { type: Object, default: undefined, select: false },
    // Master 12.18 what the employer bought: badges, subscription, premium tools, featured credits.
    employerPerks: {
      topHiringUntil: { type: Date, default: null },
      planUntil: { type: Date, default: null },
      planJobLimit: { type: Number, default: 0 },
      premiumUntil: { type: Date, default: null },
      featuredCredits: { type: Number, default: 0 }
    },
    // Master 12.17 employer fraud ladder: warning → temporary suspension → permanent ban.
    employerSanctions: {
      level: { type: String, enum: ['none', 'warning', 'suspended', 'banned'], default: 'none' },
      warnings: { type: Number, default: 0 },
      suspendedUntil: { type: Date, default: null },
      bannedAt: { type: Date, default: null },
      reason: { type: String, default: '' }
    },
    // Master 13.7: an agent whose recruitment/consultancy licence a CareerZ admin checked.
    visaConsultant: { type: Object, default: undefined },
    agentSanctions: {
      postingBanned: { type: Boolean, default: false },
      postingBanUntil: { type: Date, default: null },
      reason: { type: String, default: '' },
      licenceCancelledAt: { type: Date, default: null },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
    },
    agentProfile: {
      specialties: [{ type: String }],   // job categories the agent recruits for
      serviceCountries: [{ type: String }],
      serviceCities: [{ type: String }],
      experienceYears: { type: Number, default: 0, min: 0, max: 60 },
      bio: { type: String, default: '', maxlength: 1500 },
      acceptingRequests: { type: Boolean, default: true }
    },
    lastDigestAt: { type: Date, default: null },
    // Where this person's wallet withdrawals are paid (utils/payoutAccount.js). Never shown to others.
    payoutAccount: {
      type: { method: String, bankName: String, accountTitle: String, accountNumber: String, updatedAt: Date },
      default: undefined,
      select: false
    }
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
  return bcrypt.hash(plain, 12);
};

module.exports = mongoose.model('User', userSchema);
