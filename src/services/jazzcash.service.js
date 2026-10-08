// Real JazzCash (Pakistan) payments via the HTTP POST "Page Redirect" integration: the payer's
// browser is posted to JazzCash's own hosted page, where they choose JazzCash mobile account,
// card or voucher — card details never touch our server. No SDK; plain HTTPS + HMAC, same
// "empty keys = not configured" pattern as paddle.service.js / nowpayments.service.js.
const crypto = require('crypto');
const env = require('../config/env');

function isJazzCashConfigured() {
  const { merchantId, password, integritySalt } = env.jazzCash;
  return Boolean(merchantId && password && integritySalt);
}

function baseUrl() {
  return env.jazzCash.environment === 'production' ? 'https://payments.jazzcash.com.pk' : 'https://sandbox.jazzcash.com.pk';
}

function checkoutUrl() {
  return `${baseUrl()}/CustomerPortal/transactionmanagement/merchantform/`;
}

// JazzCash's pp_SecureHash: every pp*/ppmpf* field except pp_SecureHash, sorted by name,
// empty values dropped, values joined with '&' and prefixed by the integrity salt, then
// HMAC-SHA256 keyed with the same salt, upper-case hex.
function secureHash(fields, salt = env.jazzCash.integritySalt) {
  const values = Object.keys(fields)
    .filter((key) => /^pp/i.test(key) && key.toLowerCase() !== 'pp_securehash')
    .sort()
    .map((key) => fields[key])
    .filter((value) => value !== undefined && value !== null && String(value) !== '');
  return crypto.createHmac('sha256', salt).update([salt, ...values].join('&')).digest('hex').toUpperCase();
}

function verifySecureHash(fields) {
  const received = String(fields?.pp_SecureHash || '').toUpperCase();
  const expected = secureHash(fields);
  return /^[0-9A-F]{64}$/.test(received) && crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

// yyyyMMddHHmmss in Pakistan time — JazzCash validates these against its own PKT clock.
function pktTimestamp(date = new Date()) {
  const pkt = new Date(date.getTime() + 5 * 60 * 60 * 1000);
  return pkt.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// 'T' + timestamp + 5 random digits = 20 chars, JazzCash's maximum reference length.
function newTxnRefNo() {
  return `T${pktTimestamp()}${crypto.randomInt(0, 100000).toString().padStart(5, '0')}`;
}

// The signed form fields the frontend auto-posts to checkoutUrl(). pp_TxnType is left blank so
// JazzCash's page offers every method enabled on the merchant account (wallet, card, voucher).
function buildCheckoutFields({ txnRefNo, amountPaisa, billReference, description, returnUrl, expiryHours = 72 }) {
  const now = new Date();
  const fields = {
    pp_Version: '1.1',
    pp_TxnType: '',
    pp_Language: 'EN',
    pp_MerchantID: env.jazzCash.merchantId,
    pp_SubMerchantID: '',
    pp_Password: env.jazzCash.password,
    pp_BankID: '',
    pp_ProductID: '',
    pp_TxnRefNo: txnRefNo,
    pp_Amount: String(amountPaisa),
    pp_TxnCurrency: 'PKR',
    pp_TxnDateTime: pktTimestamp(now),
    pp_BillReference: String(billReference).replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'billRef',
    pp_Description: String(description).replace(/[^A-Za-z0-9 .,-]/g, '').slice(0, 100) || 'CareerZ payment',
    pp_TxnExpiryDateTime: pktTimestamp(new Date(now.getTime() + expiryHours * 60 * 60 * 1000)),
    pp_ReturnURL: returnUrl || env.jazzCash.returnUrl,
    ppmpf_1: '', ppmpf_2: '', ppmpf_3: '', ppmpf_4: '', ppmpf_5: ''
  };
  fields.pp_SecureHash = secureHash(fields);
  return fields;
}

// Server-to-server status inquiry — the source of truth before anything is settled. The
// browser-posted return can be replayed or forged; this call cannot.
async function inquire(txnRefNo) {
  const fields = { pp_TxnRefNo: txnRefNo, pp_MerchantID: env.jazzCash.merchantId, pp_Password: env.jazzCash.password, pp_Version: '1.1' };
  fields.pp_SecureHash = secureHash(fields);
  const response = await fetch(`${baseUrl()}/ApplicationAPI/API/PaymentInquiry/Inquire`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields), signal: AbortSignal.timeout(20000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(`JazzCash status inquiry failed (${response.status}).`);
    err.statusCode = 502;
    throw err;
  }
  return payload;
}

// '000' = paid. '124' = voucher issued, waiting for the payer to pay over the counter.
function outcomeOf(code) {
  if (code === '000') return 'paid';
  if (['124', '157', '210', ''].includes(code)) return 'awaiting_payment';
  return 'failed';
}

module.exports = {
  isJazzCashConfigured, checkoutUrl, secureHash, verifySecureHash, newTxnRefNo,
  buildCheckoutFields, inquire, outcomeOf
};
