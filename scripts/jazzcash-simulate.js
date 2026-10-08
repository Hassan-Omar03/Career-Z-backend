// Local-only JazzCash simulator: plays JazzCash's part after "Pay with JazzCash" by posting a
// correctly signed return to YOUR running local backend, then prints what happened in the DB.
//
//   npm run jazzcash:simulate                      -> latest pending checkout, success (000)
//   npm run jazzcash:simulate -- T2026...  199     -> that reference, failed
//   npm run jazzcash:simulate -- latest 124        -> latest pending checkout, voucher pending
//
// Refuses to run against the live "careerz" database or in production.
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const env = require('../src/config/env');
const jazzCash = require('../src/services/jazzcash.service');
const JazzCashPayment = require('../src/models/JazzCashPayment');
require('../src/models/WalletTransaction'); require('../src/models/Fee'); require('../src/models/CoursePurchase'); // for the report's populate()

const MESSAGES = {
  '000': 'Thank you for Using JazzCash, your transaction was successful.',
  '124': 'Order is placed and waiting for financials to be received over the counter.',
  '157': 'Transaction is pending. Please check your phone for the MPIN prompt.',
  '199': 'Sorry! Your transaction was not successful. Please try again later.'
};

async function main() {
  const [refArg = 'latest', code = '000'] = process.argv.slice(2);
  if (env.nodeEnv === 'production') throw new Error('Refusing to run in production.');
  if (env.useMemoryDb) throw new Error('USE_MEMORY_DB=true lives inside the server process; point MONGO_URI at careerz-dev instead.');
  if (!jazzCash.isJazzCashConfigured()) throw new Error('Set JAZZCASH_MERCHANT_ID, JAZZCASH_PASSWORD and JAZZCASH_INTEGRITY_SALT in .env.');

  await mongoose.connect(env.mongoUri);
  const dbName = mongoose.connection.name;
  if (dbName === 'careerz') throw new Error('Refusing to simulate payments on the live "careerz" database.');

  const payment = refArg === 'latest'
    ? await JazzCashPayment.findOne({ status: { $in: ['pending', 'awaiting_payment'] } }).sort({ createdAt: -1 })
    : await JazzCashPayment.findOne({ txnRefNo: refArg });
  if (!payment) throw new Error(`No ${refArg === 'latest' ? 'pending JazzCash checkout' : `checkout ${refArg}`} in "${dbName}". Click "Pay with JazzCash" locally first.`);

  console.log(`[simulate] db=${dbName} ref=${payment.txnRefNo} kind=${payment.kind} ${payment.currency} ${payment.amount} (PKR ${(payment.amountPaisa / 100).toFixed(2)}) status=${payment.status}`);

  const body = {
    pp_Amount: String(payment.amountPaisa), pp_BillReference: payment.kind.replace(/[^A-Za-z0-9]/g, ''),
    pp_Language: 'EN', pp_MerchantID: env.jazzCash.merchantId, pp_ResponseCode: code,
    pp_ResponseMessage: MESSAGES[code] || `Simulated response ${code}`,
    pp_RetreivalReferenceNo: code === '000' ? String(crypto.randomInt(1e11, 1e12)) : '',
    pp_TxnCurrency: 'PKR', pp_TxnDateTime: payment.txnRefNo.slice(1, 15), pp_TxnRefNo: payment.txnRefNo,
    pp_TxnType: 'MWALLET', pp_Version: '1.1'
  };
  body.pp_SecureHash = jazzCash.secureHash(body);

  const url = `http://localhost:${env.port}/api/payments/jazzcash/return`;
  const response = await fetch(url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  console.log(`[simulate] POST ${url} -> HTTP ${response.status}`);
  console.log(`[simulate] browser would go to: ${response.headers.get('location')}`);

  const after = await JazzCashPayment.findById(payment._id).populate('walletTransaction', 'status amount currency').populate('fee', 'status paymentMethod receiptNumber').populate('coursePurchase', 'status');
  console.log(`[simulate] payment: status=${after.status} code=${after.responseCode} "${after.responseMessage}"`);
  if (after.walletTransaction) console.log(`[simulate] wallet top-up: ${after.walletTransaction.status} ${after.walletTransaction.currency} ${after.walletTransaction.amount}`);
  if (after.fee) console.log(`[simulate] fee: ${after.fee.status} via ${after.fee.paymentMethod || '-'} receipt ${after.fee.receiptNumber || '-'}`);
  if (after.coursePurchase) console.log(`[simulate] course purchase: ${after.coursePurchase.status}`);
}

main()
  .catch((error) => { console.error(`[simulate] ${error.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
