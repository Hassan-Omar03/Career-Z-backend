const mongoose = require('mongoose');

// Super Admin Ad Management: an advert shown only on the allowed public pages and dashboards.
// It never runs on live classes, exams, chat, wallet or payment screens (fixed in ads.service).
const adSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    advertiser: { type: String, default: '' },
    text: { type: String, default: '' },
    image: { type: String, default: '' }, // https link or an uploaded image (data URL)
    link: { type: String, required: true },
    placements: [{ type: String, enum: ['home', 'blog', 'courses', 'institutes', 'jobs', 'marketplace', 'dashboard'] }],
    active: { type: Boolean, default: true, index: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Ad', adSchema);
