const bcrypt = require('bcryptjs');
const User = require('../models/User');
const AppError = require('./AppError');

async function assertNewPassword(user, password) {
  const saved = await User.findById(user._id).select('passwordHash +passwordHistory').lean();
  if (!saved) throw new AppError('Account not found.', 404);
  for (const hash of [saved.passwordHash, ...(saved.passwordHistory || [])]) {
    if (await bcrypt.compare(password, hash)) throw new AppError('Choose a new password. Your current password and last 3 passwords cannot be reused.', 422);
  }
}
module.exports = { assertNewPassword };
