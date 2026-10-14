const mongoose = require('mongoose');

// One translated UI string per language, shared by every visitor. Self-hosted LibreTranslate on
// a small VPS needs up to a second per string, so each string is translated once and then served
// from here, including after a server restart.
const translationCacheSchema = new mongoose.Schema(
  {
    lang: { type: String, required: true },
    key: { type: String, required: true }, // sha1 of the source text
    text: { type: String, required: true },
    translated: { type: String, required: true },
    provider: { type: String, default: '' }
  },
  { timestamps: true }
);

translationCacheSchema.index({ lang: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('TranslationCache', translationCacheSchema);
