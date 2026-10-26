const AppError = require('./AppError');

// The bank account or mobile wallet a withdrawal is paid to. Checked here so the admin never has
// to guess from a free-text box: a bank account needs the bank, the account title and an IBAN or
// account number; a mobile wallet needs the provider and an 03XX number.
const BANKS = ['HBL', 'UBL', 'MCB', 'Allied Bank', 'Bank Alfalah', 'Meezan Bank', 'Bank Al Habib', 'Askari Bank', 'Faysal Bank', 'Habib Metro', 'Standard Chartered', 'National Bank', 'Bank of Punjab', 'JS Bank', 'Soneri Bank', 'Summit Bank', 'Dubai Islamic Bank', 'BankIslami', 'Al Baraka', 'Silkbank', 'Sindh Bank', 'First Women Bank', 'Other bank'];
const WALLETS = ['JazzCash', 'Easypaisa', 'SadaPay', 'NayaPay', 'Upaisa'];

function normalize(input = {}) {
  const fail = (m) => { throw new AppError(m, 422); };
  const method = String(input.method || input.payoutMethod || '');
  const accountTitle = String(input.accountTitle || '').trim().replace(/\s+/g, ' ');
  if (accountTitle.length < 3 || accountTitle.length > 80) fail("Enter the account holder's name exactly as it appears on the account.");
  if (method === 'bank_transfer') {
    const bankName = String(input.bankName || '').trim();
    if (!BANKS.includes(bankName)) fail('Choose the bank.');
    const accountNumber = String(input.accountNumber || '').toUpperCase().replace(/[\s-]/g, '');
    if (accountNumber.startsWith('PK') ? !/^PK\d{2}[A-Z]{4}[0-9A-Z]{16}$/.test(accountNumber) : !/^\d{8,24}$/.test(accountNumber)) {
      fail('Enter a valid IBAN (PK + 22 characters) or bank account number (8 to 24 digits).');
    }
    return { method, bankName, accountTitle, accountNumber };
  }
  if (method === 'mobile_wallet') {
    const bankName = String(input.bankName || input.provider || '').trim();
    if (!WALLETS.includes(bankName)) fail('Choose the mobile wallet (JazzCash, Easypaisa, SadaPay, NayaPay or Upaisa).');
    const accountNumber = String(input.accountNumber || '').replace(/[\s-]/g, '').replace(/^\+92/, '0').replace(/^92(?=3)/, '0');
    if (!/^03\d{9}$/.test(accountNumber)) fail('Enter the wallet mobile number as 03XXXXXXXXX.');
    return { method, bankName, accountTitle, accountNumber };
  }
  return fail('Choose Bank account or Mobile wallet.');
}

const describe = (a) => `${a.accountTitle} — ${a.bankName} ${a.method === 'mobile_wallet' ? 'wallet' : 'account'} ${a.accountNumber}`;

module.exports = { normalize, describe, BANKS, WALLETS };
