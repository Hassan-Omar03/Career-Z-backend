const Setting = require('../models/Setting');

// Real receipt math (spec 3A.2: gross amount, platform commission, gateway charges, tax, net
// amount) — computed from a configurable Setting so Super Admin can change the rate without
// code (3A.1), not hardcoded. Honesty note: gatewayCharges and taxAmount stay 0 until this app
// is wired to a real payment gateway/tax engine (no gateway or tax provider is connected yet
// anywhere in this codebase) — the fields exist and are wired into every receipt now so that
// connecting one later only means changing this function, not every call site.
// The fee commission the Super Admin sets (Financial Management) is stored as
// 'institution_fee_commission_percent'; older code reads 'fee_commission_percent', kept as a fallback.
const KEY_ALIASES = { fee_commission_percent: ['institution_fee_commission_percent', 'fee_commission_percent'] };
async function commissionRate(commissionSettingKey, session = null) {
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

async function computeReceiptAmounts(grossAmount, commissionSettingKey) {
  const commissionRate_ = await commissionRate(commissionSettingKey);

  const platformCommission = Math.round((grossAmount * commissionRate_) / 100 * 100) / 100;
  const gatewayCharges = 0;
  const taxAmount = 0;
  const netAmount = Math.round((grossAmount - platformCommission - gatewayCharges - taxAmount) * 100) / 100;

  return { grossAmount, platformCommission, gatewayCharges, taxAmount, netAmount };
}

module.exports = { computeReceiptAmounts, commissionRate };
