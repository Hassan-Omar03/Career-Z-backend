const mongoose = require('mongoose');

// Master 13.7 Government Compliance: for each country its work-permit, visa, immigration and
// labour rules, salary standards, contract rules, working hours and age requirements. Kept by
// CareerZ admins as information only; CareerZ never grants visas.
const countryRuleSchema = new mongoose.Schema(
  {
    country: { type: String, required: true, unique: true, uppercase: true, trim: true }, // ISO code, e.g. AE
    name: { type: String, required: true, trim: true },
    workPermit: { type: String, default: '' },
    visaRules: { type: String, default: '' },
    immigrationRules: { type: String, default: '' },
    laborLaws: { type: String, default: '' },
    salaryStandards: { type: String, default: '' },
    contractRules: { type: String, default: '' },
    workingHours: { type: String, default: '' },
    ageRequirements: { type: String, default: '' },
    visaTypes: [{ type: String }],
    requiredDocuments: [{ type: String }],
    officialLinks: [{ label: String, url: String, _id: false }],
    published: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('CountryRule', countryRuleSchema);
