const mongoose = require('mongoose');

const lessonSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    title: { type: String, required: true },
    content: { type: String, default: '' }, // text/notes
    videoUrl: { type: String, default: null }, // external provider link (client-configured)
    resources: [{ name: String, url: String }],
    order: { type: Number, default: 0 }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Lesson', lessonSchema);
