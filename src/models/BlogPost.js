const mongoose = require('mongoose');

// Blog / Knowledge Center posts (spec Part 16F.9). Same publish workflow as Page, plus a
// category and author byline since posts are attributed and browsable by topic.
const blogPostSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    title: { type: String, required: true, trim: true },
    excerpt: { type: String, default: '' },
    content: { type: String, default: '' },
    category: { type: String, default: '' },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    coverImage: { type: String, default: '' },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    publishedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('BlogPost', blogPostSchema);
