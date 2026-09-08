const mongoose = require('mongoose');

const campusSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    name: { type: String, required: true },
    address: { type: String, default: '' },
    city: { type: String, default: '' },
    isMain: { type: Boolean, default: false }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Campus', campusSchema);
