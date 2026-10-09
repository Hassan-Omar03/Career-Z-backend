const mongoose = require('mongoose');
const crypto = require('crypto');

// A generated subtitle track (WebVTT) for a lesson: an AI transcript, or a translation of one.
// Served publicly at /api/media-accessibility/tracks/<token>.vtt so <video><track> can load it.
const captionTrackSchema = new mongoose.Schema({
  lesson: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', required: true, index: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  language: { type: String, required: true, lowercase: true, trim: true, maxlength: 12 },
  label: { type: String, required: true, maxlength: 60 },
  source: { type: String, enum: ['ai_transcript', 'translation'], required: true },
  fromTrack: { type: mongoose.Schema.Types.ObjectId, ref: 'CaptionTrack', default: null },
  mediaUrl: { type: String, default: '' },
  vtt: { type: String, required: true, maxlength: 2 * 1024 * 1024 },
  token: { type: String, required: true, unique: true, default: () => crypto.randomBytes(16).toString('hex') },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

module.exports = mongoose.model('CaptionTrack', captionTrackSchema);
