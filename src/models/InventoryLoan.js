const mongoose = require('mongoose');
const schema = new mongoose.Schema({
 institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
 item: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
 recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
 quantity: { type: Number, required: true, min: 1, validate: Number.isInteger },
 status: { type: String, enum: ['pending','issued','return_requested','returned','rejected','cancelled'], default: 'pending' },
 reason: { type: String, default: '' }, dueDate: { type: Date, default: null }, issuedAt: Date, returnedAt: Date,
 damageReported: { type: Boolean, default: false }, damageNotes: { type: String, default: '' },
 history: [{ action: String, notes: String, actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: { type: Date, default: Date.now } }]
}, { timestamps: true });
module.exports = mongoose.model('InventoryLoan', schema);
