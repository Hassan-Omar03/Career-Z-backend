const AppError = require('./AppError');

// Payout requests (agent commission, marketplace seller) move one way only:
// requested -> processing -> paid | rejected. Paid and rejected are final, so a sent payout can
// never be reopened and its money made withdrawable again.
const NEXT = { requested: ['processing', 'paid', 'rejected'], processing: ['paid', 'rejected'], paid: [], rejected: [] };

// Moves `Model` document `id` to `status` in one conditional write; a parallel or repeated
// decision finds the status already changed and gets a 409.
async function advancePayout(Model, id, status, extra = {}) {
  if (!Object.prototype.hasOwnProperty.call(NEXT, status) || status === 'requested') throw new AppError('Invalid status.', 422);
  const from = Object.keys(NEXT).filter((s) => NEXT[s].includes(status));
  const updated = await Model.findOneAndUpdate({ _id: id, status: { $in: from } }, { $set: { status, ...extra } }, { new: true });
  if (updated) return updated;
  const current = await Model.findById(id).select('status');
  if (!current) throw new AppError('Withdrawal not found.', 404);
  throw new AppError(`This withdrawal is already ${current.status}; it cannot be moved to ${status}.`, 409);
}

module.exports = { advancePayout };
