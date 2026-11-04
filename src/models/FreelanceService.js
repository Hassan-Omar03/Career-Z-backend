const mongoose = require('mongoose');

const CATEGORIES = ['home_tuition', 'online_tuition', 'admission_consultancy', 'career_counselling', 'visa_consultancy', 'research_assistance', 'translation', 'certification_support', 'training', 'mentoring', 'design', 'development', 'writing', 'other'];

const packageSchema = new mongoose.Schema({
  tier: { type: String, enum: ['basic', 'standard', 'premium'], required: true },
  name: { type: String, trim: true, maxlength: 60, default: '' },
  price: { type: Number, required: true, min: 1 },
  deliveryDays: { type: Number, required: true, min: 1, max: 365 },
  revisions: { type: Number, default: 0, min: 0, max: 50 },
  includes: { type: String, trim: true, maxlength: 600, default: '' }
}, { _id: false });

const schema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  category: { type: String, enum: CATEGORIES, default: 'other', index: true },
  description: { type: String, trim: true, maxlength: 6000, default: '' },
  image: { type: String, trim: true, maxlength: 600, default: '' },
  currency: { type: String, default: 'PKR' },
  startingAt: { type: Number, default: 0, index: true },
  packages: { type: [packageSchema], default: [] },
  status: { type: String, enum: ['active', 'paused', 'pending_review', 'removed'], default: 'active', index: true },
  moderation: { flags: [{ code: String, label: String, points: Number, hold: Boolean }], at: Date },
  adminRemoval: { by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, at: { type: Date, default: null }, reason: { type: String, default: '' } }
}, { timestamps: true });
schema.index({ title: 'text', description: 'text' });

module.exports = mongoose.model('FreelanceService', schema);
module.exports.CATEGORIES = CATEGORIES;
