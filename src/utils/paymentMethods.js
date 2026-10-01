// Shared payment-method vocabulary used everywhere money is self-confirmed in this app — most of
// these are still self-attested (no gateway involved), EXCEPT 'stripe_transfer' on a Payslip,
// which is a real Stripe Connect transfer to the recipient's own connected bank account (see
// institution.controller.js markPayslipPaid). Two lists: PAYMENT_METHODS for someone PAYING money
// in, PAYOUT_METHODS for someone RECEIVING a payout (no "card"/"cash" — you don't receive a
// payout in cash-in-hand or to a card in this app).
const PAYMENT_METHOD_LABEL = {
  bank_transfer: 'Bank Transfer', card: 'Card', mobile_wallet: 'Mobile Wallet', cash: 'Cash', other: 'Other'
};
const PAYOUT_METHOD_LABEL = {
  bank_transfer: 'Bank Transfer', mobile_wallet: 'Mobile Wallet', crypto: 'Crypto Wallet', other: 'Other', stripe_transfer: 'Real Bank Transfer (Stripe)'
};

module.exports = { PAYMENT_METHOD_LABEL, PAYOUT_METHOD_LABEL };
