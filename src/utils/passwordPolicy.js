const AppError = require('./AppError');

// Every password set by a person (signup, reset, change) must contain at least one uppercase
// letter, one lowercase letter and one special character, with at least 8 characters overall.
// Length has a generous upper bound only because bcrypt ignores bytes past 72.
const RULES = [
  [(p) => p.length >= 8, 'at least 8 characters'],
  [(p) => /[A-Z]/.test(p), 'one capital letter (A-Z)'],
  [(p) => /[a-z]/.test(p), 'one small letter (a-z)'],
  [(p) => /[^A-Za-z0-9\s]/.test(p), 'one special character (e.g. ! @ # $ %)']
];

function passwordProblems(password) {
  if (typeof password !== 'string') return RULES.map(([, label]) => label);
  return RULES.filter(([check]) => !check(password)).map(([, label]) => label);
}

function assertStrongPassword(password, field = 'Password') {
  if (typeof password === 'string' && Buffer.byteLength(password) > 72) throw new AppError(`${field} must be at most 72 characters.`, 422);
  const missing = passwordProblems(password);
  if (missing.length) throw new AppError(`${field} must contain ${missing.join(', ')}.`, 422, { password: missing });
}

module.exports = { assertStrongPassword, passwordProblems };
