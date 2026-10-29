const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    unitPrice: { type: Number, required: true },
    totalPrice: { type: Number, required: true },
    currency: { type: String, default: 'PKR' },
    shippingAddress: { type: String, default: '' },
    // Who receives the parcel and where (required for physical items; the seller ships to this).
    shipping: {
      name: { type: String, default: '' }, phone: { type: String, default: '' }, cnic: { type: String, default: '' },
      address: { type: String, default: '' }, city: { type: String, default: '' }, province: { type: String, default: '' },
      postalCode: { type: String, default: '' }, landmark: { type: String, default: '' }, locationUrl: { type: String, default: '' }
    },
    // Tracking: every step with its time, and the courier details once shipped.
    timeline: [{ status: String, at: { type: Date, default: Date.now }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, note: { type: String, default: '' }, _id: false }],
    shipment: { courier: { type: String, default: '' }, trackingNo: { type: String, default: '' }, trackingUrl: { type: String, default: '' }, shippedAt: { type: Date, default: null } },
    stockReturned: { type: Boolean, default: false },
    // Buyer and seller talk about this order (works for quick-checkout buyers too).
    messages: [{ from: { type: String, enum: ['buyer', 'seller'] }, text: { type: String, required: true }, at: { type: Date, default: Date.now }, _id: false }],
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
    refundReason: { type: String, default: '' },
    // Master 16B escrow: CareerZ holds the buyer's payment until delivery is confirmed.
    escrow: {
      status: { type: String, enum: ['', 'held', 'disputed', 'released', 'refund_due', 'refunded'], default: '' },
      amount: { type: Number, default: 0 },
      fee: { type: Number, default: 0 },
      heldAt: { type: Date, default: null },
      releasedAt: { type: Date, default: null },
      releasedBy: { type: String, enum: ['', 'buyer', 'otp', 'auto', 'admin'], default: '' },
      refundedAt: { type: Date, default: null },
      refundRef: { type: String, default: '' }
    },
    // Delivery OTP: the buyer gives it to the seller only on receiving the item.
    deliveryCode: { type: String, default: '', select: false },
    deliveryCodeTries: { type: Number, default: 0 },
    deliveredAt: { type: Date, default: null },
    deliveredVia: { type: String, enum: ['', 'otp', 'seller', 'buyer'], default: '' },
    dispute: {
      open: { type: Boolean, default: false },
      reason: { type: String, default: '' },
      openedAt: { type: Date, default: null },
      evidence: [{ by: { type: String, enum: ['buyer', 'seller'] }, note: { type: String, default: '' }, file: { type: mongoose.Schema.Types.ObjectId, ref: 'PrivateFile', default: null }, at: { type: Date, default: Date.now }, _id: false }],
      decision: { type: String, enum: ['', 'release', 'refund'], default: '' },
      decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      decidedAt: { type: Date, default: null },
      note: { type: String, default: '' }
    },
    // Digital products: every view or download of the purchased file (evidence for auto-release and disputes).
    accessLog: [{ action: { type: String, enum: ['view', 'download'] }, at: { type: Date, default: Date.now }, ip: { type: String, default: '' }, _id: false }]
  },
  { timestamps: true }
);

module.exports = mongoose.model('Order', orderSchema);
