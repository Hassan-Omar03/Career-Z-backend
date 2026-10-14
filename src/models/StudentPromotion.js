const mongoose = require('mongoose');

// A class moved up (or graduated) in one go, kept as a permanent record of who moved, who was
// held back and why, and who did it (master spec 8.8 "Promote students").
const studentPromotionSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    action: { type: String, enum: ['promote', 'graduate'], required: true },
    fromSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', required: true },
    toSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', default: null },
    moved: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    heldBack: [{ student: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, reason: { type: String, default: '' } }],
    note: { type: String, default: '', maxlength: 500 },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('StudentPromotion', studentPromotionSchema);
