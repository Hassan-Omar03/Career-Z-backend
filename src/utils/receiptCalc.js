const Setting = require('../models/Setting');

// Real receipt math (spec 3A.2: gross amount, platform commission, gateway charges, tax, net
// amount) — computed from a configurable Setting so Super Admin can change the rate without
// code (3A.1), not hardcoded. Honesty note: gatewayCharges and taxAmount stay 0 until this app
// is wired to a real payment gateway/tax engine (no gateway or tax provider is connected yet
// anywhere in this codebase) — the fields exist and are wired into every receipt now so that
// connecting one later only means changing this function, not every call site.
async function computeReceiptAmounts(grossAmount, commissionSettingKey) {
  const setting = await Setting.findOne({ key: commissionSettingKey });
  const commissionRate = setting ? Number(setting.value) || 0 : 0;

  const platformCommission = Math.round((grossAmount * commissionRate) / 100 * 100) / 100;
  const gatewayCharges = 0;
  const taxAmount = 0;
  const netAmount = Math.round((grossAmount - platformCommission - gatewayCharges - taxAmount) * 100) / 100;

  return { grossAmount, platformCommission, gatewayCharges, taxAmount, netAmount };
}

module.exports = { computeReceiptAmounts };
