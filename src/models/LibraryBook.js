const mongoose = require('mongoose');

// Digital + Physical Library (spec 15D.10).
const libraryBookSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    title: { type: String, required: true, trim: true },
    author: { type: String, default: '' },
    isbn: { type: String, default: '' },
    category: { type: String, enum: ['book', 'ebook', 'journal', 'research_paper'], default: 'book' },
    copies: { type: Number, default: 1, min: 0 }, // physical copies (0 for pure eBooks/journals)
    availableCopies: { type: Number, default: 1, min: 0 },
    fileUrl: { type: String, default: '' }, // eBook/journal/research paper file link
    coverImage: { type: String, default: '' },
    // Same crypto-verify pattern as Certificate/StudentProfile — lets a librarian scan the
    // book's QR sticker to look it up instantly instead of searching by title.
    qrCode: { type: String, required: true, unique: true, default: () => require('crypto').randomBytes(8).toString('hex') },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('LibraryBook', libraryBookSchema);
