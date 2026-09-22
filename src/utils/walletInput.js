const AppError = require('./AppError');

function validateAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new AppError('A positive, finite numeric amount is required.', 422);
  }
  return amount;
}

function normalizeCurrency(currency = 'USD') {
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
    throw new AppError('A three-letter currency code is required.', 422);
  }
  return currency.toUpperCase();
}

module.exports = { validateAmount, normalizeCurrency };
