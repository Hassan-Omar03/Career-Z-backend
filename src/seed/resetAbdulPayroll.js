require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const Institution = require('../models/Institution');
const Payslip = require('../models/Payslip');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');

async function run() {
  await connectDB();
  const [warden, institution] = await Promise.all([
    User.findOne({ email: 'hostel.warden@careerz.local' }),
    Institution.findOne({ slug: 'gcuf' })
  ]);
  if (!warden || !institution) throw new Error('Seeded GCUF warden or institution was not found.');

  const payslips = await Payslip.find({ institution: institution._id, staff: warden._id });
  let reversed = 0;
  for (const payslip of payslips) {
    if (payslip.status === 'paid' && payslip.paymentMethod === 'platform_wallet' && payslip.netAmount > 0) {
      const employeeWallet = await Wallet.findOne({ user: warden._id, currency: payslip.currency });
      if (!employeeWallet || Number(employeeWallet.available || 0) < payslip.netAmount) {
        throw new Error(`Cannot reverse ${payslip.currency} ${payslip.netAmount}: Abdul's wallet balance is insufficient.`);
      }
      await mongoose.connection.transaction(async (session) => {
        await Wallet.updateOne({ _id: employeeWallet._id }, { $inc: { available: -payslip.netAmount } }, { session });
        await Wallet.findOneAndUpdate({ user: institution.owner, currency: payslip.currency }, { $inc: { available: payslip.netAmount } }, { upsert: true, session, setDefaultsOnInsert: true });
        await WalletTransaction.create([
          { user: warden._id, type: 'transfer_out', amount: payslip.netAmount, currency: payslip.currency, status: 'completed', counterparty: institution.owner, note: `QA payroll reset reversal ${payslip.month}/${payslip.year}` },
          { user: institution.owner, type: 'transfer_in', amount: payslip.netAmount, currency: payslip.currency, status: 'completed', counterparty: warden._id, note: `QA payroll reset reversal ${payslip.month}/${payslip.year}` }
        ], { session, ordered: true });
      });
      reversed += payslip.netAmount;
    }
  }
  const result = await Payslip.deleteMany({ institution: institution._id, staff: warden._id });
  console.log('[SEED] Abdul Rehman payroll reset:', { deletedPayslips: result.deletedCount, walletAmountReversed: reversed, readyToGenerateAgain: true });
}

run().then(() => mongoose.disconnect()).then(() => process.exit(0)).catch(async (error) => {
  console.error('[SEED] Abdul payroll reset failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
