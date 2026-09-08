const mongoose = require('mongoose');

const courseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null },
    classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', default: null },

    subject: { type: String, default: '' },
    level: { type: String, default: '' },
    language: { type: String, default: 'en' },

    price: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    isFree: { type: Boolean, default: true },

    thumbnail: { type: String, default: null },
    published: { type: Boolean, default: false },

    certificateEnabled: { type: Boolean, default: false }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Course', courseSchema);
