const mongoose = require('mongoose');

// A commission rate for one service, narrowed to a country, institution, category or product.
// The most specific active rule wins; with no rule, the service's rate in Financial Management applies.
const SCOPES = ['global', 'country', 'category', 'institution', 'product'];
const SERVICES = ['marketplace', 'course', 'tuition', 'tutoring', 'recruitment', 'donation', 'scholarship', 'freelance'];

const commissionRuleSchema = new mongoose.Schema({
  name: { type: String, trim: true, maxlength: 120, default: '' },
  scope: { type: String, enum: SCOPES, required: true },
  scopeValue: { type: String, trim: true, default: '' },
  serviceType: { type: String, enum: SERVICES, required: true, index: true },
  percentage: { type: Number, required: true, min: 0, max: 100 },
  fixedFee: { type: Number, default: 0, min: 0 },
  effectiveFrom: { type: Date, default: null },
  effectiveUntil: { type: Date, default: null },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  history: [{
    action: { type: String, required: true },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

module.exports = mongoose.model('CommissionRule', commissionRuleSchema);
module.exports.SCOPES = SCOPES;
module.exports.SERVICES = SERVICES;
