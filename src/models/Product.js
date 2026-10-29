const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    category: {
      type: String,
      enum: ['books', 'stationery', 'uniform', 'electronics', 'notes', 'courses', 'services', 'other'],
      default: 'other'
    },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'PKR' },
    stock: { type: Number, default: 0, min: 0 },
    images: [{ type: String }],
    // A digital product (PDF): buyers see only a stamped preview before paying; after paying they
    // read online or download (seller's choice) a copy stamped with their name, ID and date.
    digital: {
      file: { type: mongoose.Schema.Types.ObjectId, ref: 'PrivateFile', default: null },
      fileName: { type: String, default: '' },
      pages: { type: Number, default: 0 },
      access: { type: String, enum: ['download', 'online'], default: 'download' }
    },
    views: { type: Number, default: 0 }, // real page views, incremented on getProduct
    // draft: seller hasn't submitted it yet -> pending_approval: submitted, awaiting Super Admin
    // review -> active: approved and live -> rejected: admin declined (see reviewNotes) ->
    // out_of_stock: system-set automatically when stock hits 0 -> paused: seller took it down themselves.
    status: {
      type: String,
      enum: ['draft', 'pending_approval', 'active', 'rejected', 'out_of_stock', 'paused', 'removed'],
      default: 'pending_approval'
    },
    reviewNotes: { type: String, default: '' },
    // The automatic check (autoModeration.service): reasons when it held the listing for an admin.
    moderation: { flags: [{ code: String, label: String, points: Number, hold: Boolean, _id: false }], held: { type: Boolean, default: false }, checkedAt: { type: Date, default: null } }
  },
  { timestamps: true }
);

productSchema.index({ title: 'text', description: 'text' });

module.exports = mongoose.model('Product', productSchema);
