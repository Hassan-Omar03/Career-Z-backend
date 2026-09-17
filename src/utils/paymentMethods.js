// Shared payment-method vocabulary used everywhere money is self-confirmed in this app (no real
// payment gateway is connected yet — see Fee/Donation/Payslip/Withdrawal models). Two lists:
// PAYMENT_METHODS for someone PAYING money in, PAYOUT_METHODS for someone RECEIVING a payout
// (no "card"/"cash" — you don't receive a payout in cash-in-hand or to a card in this app).
const PAYMENT_METHOD_LABEL = {
  bank_transfer: 'Bank Transfer', card: 'Card', mobile_wallet: 'Mobile Wallet', cash: 'Cash', other: 'Other'
};
const PAYOUT_METHOD_LABEL = {
  bank_transfer: 'Bank Transfer', mobile_wallet: 'Mobile Wallet', other: 'Other'
};

module.exports = { PAYMENT_METHOD_LABEL, PAYOUT_METHOD_LABEL };
