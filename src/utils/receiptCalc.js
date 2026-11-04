const Setting = require('../models/Setting');

// Real receipt math (spec 3A.2: gross amount, platform commission, gateway charges, tax, net
// amount) — computed from a configurable Setting so Super Admin can change the rate without
// code (3A.1), not hardcoded.
// The fee commission the Super Admin sets (Financial Management) is stored as
// 'institution_fee_commission_percent'; older code reads 'fee_commission_percent', kept as a fallback.
const KEY_ALIASES = { fee_commission_percent: ['institution_fee_commission_percent', 'fee_commission_percent'] };
// context: what is being paid for ({ amount, country, category, institution, product }). A matching
// Commission Rule beats the service's plain rate; a rule's fixed fee is turned into the same percent.
async function commissionRate(commissionSettingKey, session = null, context = {}) {
  const rules = require('../services/commissionRules.service');
  const rule = await rules.bestRule(rules.serviceOf(commissionSettingKey), context, session);
  if (rule) {
    const extra = rule.fixedFee > 0 && context.amount > 0 ? (rule.fixedFee / context.amount) * 100 : 0;
    return Math.min(100, Math.round((rule.percentage + extra) * 10000) / 10000);
  }
  for (const key of KEY_ALIASES[commissionSettingKey] || [commissionSettingKey]) {
    const query = Setting.findOne({ key });
    if (session) query.session(session);
    const setting = await query;
    if (setting) {
      const rate = Number(setting.value);
      return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : 0;
    }
  }
  return 0;
}

async function computeReceiptAmounts(grossAmount, commissionSettingKey, context = {}) {
  const commissionRate_ = await commissionRate(commissionSettingKey, null, { amount: grossAmount, ...context });

  const platformCommission = Math.round((grossAmount * commissionRate_) / 100 * 100) / 100;
  // Set by the Super Admin (Receipts). Both come out of CareerZ's commission, so the seller's net is unchanged.
  const { taxPercent, gatewayFeePercent } = await require('../services/receipt.service').chargesConfig();
  const gatewayCharges = Math.round((grossAmount * gatewayFeePercent) / 100 * 100) / 100;
  const taxAmount = Math.round((platformCommission * taxPercent) / 100 * 100) / 100;
  const netAmount = Math.round((grossAmount - platformCommission) * 100) / 100;

  return { grossAmount, platformCommission, gatewayCharges, taxAmount, netAmount };
}

module.exports = { computeReceiptAmounts, commissionRate };
