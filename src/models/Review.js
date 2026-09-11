const mongoose = require('mongoose');

// A real, verified-purchase review — a buyer can only leave one after their own order for
// that product is marked "delivered" (enforced in the controller, not here).
const reviewSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '' },
    sellerResponse: { type: String, default: '' },
    sellerRespondedAt: { type: Date, default: null },
    reported: { type: Boolean, default: false },
    reportReason: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Review', reviewSchema);
