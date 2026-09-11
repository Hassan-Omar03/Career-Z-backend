const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    category: {
      type: String,
      enum: ['books', 'stationery', 'uniform', 'electronics', 'courses', 'services', 'other'],
      default: 'other'
    },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    stock: { type: Number, default: 0, min: 0 },
    images: [{ type: String }],
    views: { type: Number, default: 0 }, // real page views, incremented on getProduct
    // draft: seller hasn't submitted it yet -> pending_approval: submitted, awaiting Super Admin
    // review -> active: approved and live -> rejected: admin declined (see reviewNotes) ->
    // out_of_stock: system-set automatically when stock hits 0 -> paused: seller took it down themselves.
    status: {
      type: String,
      enum: ['draft', 'pending_approval', 'active', 'rejected', 'out_of_stock', 'paused'],
      default: 'pending_approval'
    },
    reviewNotes: { type: String, default: '' }
  },
  { timestamps: true }
);

productSchema.index({ title: 'text', description: 'text' });

module.exports = mongoose.model('Product', productSchema);
