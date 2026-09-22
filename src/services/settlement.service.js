const mongoose = require('mongoose');
const { notify } = require('./notification.service');

// Unique-index races may occur when two deliveries first create the same ledger entry.
// Re-run on a fresh snapshot; all effects from the failed attempt have rolled back.
async function transactionWithDuplicateRetry(work) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await mongoose.connection.transaction(work);
    } catch (error) {
      if (error.code !== 11000 || attempt >= 2) throw error;
    }
  }
}

async function sendSettlementNotifications(notifications = []) {
  for (const { userId, payload } of notifications) {
    await notify(userId, payload).catch(() => {});
  }
}

// A webhook supplies its transaction; a checkout sync creates its own.
async function settle(work, session) {
  if (session) return work(session);
  const notifications = await transactionWithDuplicateRetry(work);
  await sendSettlementNotifications(notifications);
  return notifications;
}

module.exports = { transactionWithDuplicateRetry, sendSettlementNotifications, settle };
