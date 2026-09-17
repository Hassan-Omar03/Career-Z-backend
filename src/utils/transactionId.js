// Real, unique, server-generated payment reference — used everywhere a user self-confirms a
// payment in this app (no real payment gateway exists yet, see Donation/Order/Fee models).
function generateTransactionId() {
  return `TXN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

module.exports = { generateTransactionId };
