const mongoose = require('mongoose');

// A record of one full-database export (spec Part 4.32 / 16D.12 "Backup System"). The actual
// files live on disk under backend/backups/<folder>/ — this document is the manifest: what was
// exported, how big it was, and who triggered it.
const backupSchema = new mongoose.Schema(
  {
    folder: { type: String, required: true, unique: true },
    collections: [{ name: String, documentCount: Number, sizeBytes: Number }],
    totalSizeBytes: { type: Number, default: 0 },
    status: { type: String, enum: ['completed', 'failed'], default: 'completed' },
    error: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Backup', backupSchema);
