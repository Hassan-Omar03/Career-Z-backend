const mongoose = require('mongoose');

// Inventory Management (spec 15D.13) — tracks institutional assets (computers, projectors,
// furniture, lab/sports equipment).
const inventoryItemSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ['computer', 'projector', 'furniture', 'lab_equipment', 'sports_equipment', 'other'],
      default: 'other'
    },
    quantity: { type: Number, default: 1, min: 0 },
    location: { type: String, default: '' }, // e.g. "Lab 2", "Room 104"
    condition: { type: String, enum: ['new', 'good', 'needs_repair', 'damaged'], default: 'good' },
    purchaseDate: { type: Date, default: null },
    purchaseCost: { type: Number, default: 0 },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // e.g. a teacher holding a laptop
    notes: { type: String, default: '' },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('InventoryItem', inventoryItemSchema);
