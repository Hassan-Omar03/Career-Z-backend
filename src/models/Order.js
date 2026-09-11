const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    unitPrice: { type: Number, required: true },
    totalPrice: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    shippingAddress: { type: String, default: '' },
    note: { type: String, default: '' },
    // Fulfillment lifecycle. DB keeps 'pending' as the first value for backward compatibility —
    // the seller-facing UI labels it "New". 'completed' is a distinct terminal state from
    // 'delivered' (fully closed out, e.g. return window passed), and 'refunded' can follow either.
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded'],
      default: 'pending'
    },
    // Separate from fulfillment status — there's no real payment gateway in this app, so this is
    // a seller-confirmed record of whether the money actually came in.
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending'
    },
    // Buyer-initiated requests the seller must act on — Pending Actions items 5 & 6. The buyer
    // asks; the seller approves (order moves to cancelled/refunded) or denies (flag just clears).
    cancellationRequested: { type: Boolean, default: false },
    cancellationReason: { type: String, default: '' },
    refundRequested: { type: Boolean, default: false },
    refundReason: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Order', orderSchema);
