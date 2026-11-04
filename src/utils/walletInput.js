const AppError = require('./AppError');

function validateAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new AppError('A positive, finite numeric amount is required.', 422);
  }
  return amount;
}

// An amount a person typed for a new withdrawal, transfer or top-up. Not used on stored entries,
// which may hold more decimals from a currency conversion.
const MAX_ENTERED = 1000000000;
function validateEntered(amount) {
  validateAmount(amount);
  if (amount < 0.01 || amount > MAX_ENTERED) throw new AppError('Enter an amount between 0.01 and 1,000,000,000.', 422);
  if (Number(amount.toFixed(2)) !== amount) throw new AppError('The amount can have at most 2 decimal places.', 422);
  return amount;
}

function normalizeCurrency(currency = 'PKR') {
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
    throw new AppError('A three-letter currency code is required.', 422);
  }
  return currency.toUpperCase();
}

module.exports = { validateAmount, validateEntered, normalizeCurrency };
