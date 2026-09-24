const mongoose = require('mongoose');

const lessonSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    title: { type: String, required: true },
    content: { type: String, default: '' }, // text/notes
    videoUrl: { type: String, default: null }, // external provider link (client-configured)
    resources: [{ name: String, url: String }],
    kind: { type: String, enum: ['lesson', 'slide_deck'], default: 'lesson', index: true },
    published: { type: Boolean, default: true, index: true },
    deck: {
      version: { type: Number, default: 1 },
      slides: [{
        title: { type: String, maxlength: 300 },
        bullets: [{ type: String, maxlength: 2000 }],
        background: { type: String, maxlength: 20 },
        accent: { type: String, maxlength: 20 },
        text: { type: String, maxlength: 20 },
        imageUrl: { type: String, maxlength: 3000 }
      }]
    },
    order: { type: Number, default: 0 }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Lesson', lessonSchema);
