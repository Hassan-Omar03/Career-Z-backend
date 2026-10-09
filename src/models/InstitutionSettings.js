const mongoose = require('mongoose');

// Per-institution configuration: classroom recording policy, branding/theme, public pages,
// subdomain, timezone and working week.
const pageSchema = new mongoose.Schema({
  slug: { type: String, required: true, lowercase: true, trim: true, match: /^[a-z0-9-]{1,60}$/ },
  title: { type: String, required: true, trim: true, maxlength: 150 },
  body: { type: String, default: '', maxlength: 20000 },
  published: { type: Boolean, default: false }
}, { _id: false });

const institutionSettingsSchema = new mongoose.Schema({
  institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, unique: true },
  classroom: {
    // disabled: nobody records; teacher_choice: the teacher may record; always_allowed: same, and
    // recording is on by default for every live class.
    recordingPolicy: { type: String, enum: ['disabled', 'teacher_choice', 'always_allowed'], default: 'teacher_choice' },
    requireStudentConsent: { type: Boolean, default: false },
    recordingRetentionDays: { type: Number, default: 0, min: 0, max: 3650 } // 0 = keep
  },
  branding: {
    primaryColor: { type: String, default: '', match: /^(#[0-9a-fA-F]{6})?$/ },
    accentColor: { type: String, default: '', match: /^(#[0-9a-fA-F]{6})?$/ },
    bannerUrl: { type: String, default: '', match: /^(https:\/\/.+)?$/ },
    tagline: { type: String, default: '', maxlength: 200 }
  },
  pages: { type: [pageSchema], default: [] },
  subdomain: { type: String, lowercase: true, trim: true, default: undefined, match: /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/ },
  timezone: { type: String, default: 'Asia/Karachi' },
  workingDays: { type: [Number], default: [1, 2, 3, 4, 5] }, // 0 = Sunday ... 6 = Saturday
  schoolHours: {
    start: { type: String, default: '08:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    end: { type: String, default: '14:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ }
  },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

institutionSettingsSchema.index({ subdomain: 1 }, { unique: true, partialFilterExpression: { subdomain: { $type: 'string' } } });

module.exports = mongoose.model('InstitutionSettings', institutionSettingsSchema);
