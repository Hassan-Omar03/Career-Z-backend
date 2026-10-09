const mongoose = require('mongoose');

// An ordered collection of lessons. private = only the owner; course = students enrolled in
// `course` (every item must be from that course); institution = the institution's members (every
// item must be from that institution's courses).
const playlistSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 150 },
  description: { type: String, default: '', maxlength: 2000 },
  visibility: { type: String, enum: ['private', 'course', 'institution'], default: 'private' },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null, index: true },
  institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', default: null, index: true },
  items: [{ lesson: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', required: true }, note: { type: String, default: '', maxlength: 300 }, _id: false }]
}, { timestamps: true });

module.exports = mongoose.model('Playlist', playlistSchema);
