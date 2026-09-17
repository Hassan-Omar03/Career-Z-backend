const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Backup = require('../models/Backup');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

const BACKUPS_ROOT = path.join(__dirname, '..', '..', 'backups');

// GET /api/admin/backups
const listBackups = asyncHandler(async (req, res) => {
  const backups = await Backup.find().populate('createdBy', 'fullName').sort({ createdAt: -1 }).limit(50);
  return ok(res, backups);
});

// POST /api/admin/backups — dumps every real collection in the database to JSON files on disk.
// This is a genuine, working export (not a stub) — but restoring from it is intentionally NOT
// automated here: overwriting live production data is exactly the kind of destructive action
// that needs a human doing it deliberately, not a one-click button, so only creation + listing
// + per-file download are exposed via the API.
const createBackup = asyncHandler(async (req, res) => {
  if (!fs.existsSync(BACKUPS_ROOT)) fs.mkdirSync(BACKUPS_ROOT, { recursive: true });

  const folder = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const folderPath = path.join(BACKUPS_ROOT, folder);

  try {
    fs.mkdirSync(folderPath);

    const modelNames = mongoose.modelNames();
    const collections = [];
    let totalSizeBytes = 0;

    for (const name of modelNames) {
      const Model = mongoose.model(name);
      const docs = await Model.find().lean();
      const json = JSON.stringify(docs, null, 2);
      const filePath = path.join(folderPath, `${name}.json`);
      fs.writeFileSync(filePath, json, 'utf8');
      const sizeBytes = Buffer.byteLength(json, 'utf8');
      totalSizeBytes += sizeBytes;
      collections.push({ name, documentCount: docs.length, sizeBytes });
    }

    const backup = await Backup.create({
      folder, collections, totalSizeBytes, status: 'completed', createdBy: req.user._id
    });
    return created(res, backup, `Backup complete — ${modelNames.length} collections, ${(totalSizeBytes / 1024).toFixed(1)} KB.`);
  } catch (err) {
    await Backup.create({ folder, status: 'failed', error: err.message, createdBy: req.user._id }).catch(() => {});
    throw new AppError(`Backup failed: ${err.message}`, 500);
  }
});

// GET /api/admin/backups/:id/files/:filename — download one collection's JSON dump from a backup.
const downloadBackupFile = asyncHandler(async (req, res) => {
  const backup = await Backup.findById(req.params.id);
  if (!backup) throw new AppError('Backup not found.', 404);

  const safeName = path.basename(req.params.filename); // prevent path traversal
  const known = backup.collections.some((c) => `${c.name}.json` === safeName);
  if (!known) throw new AppError('That file is not part of this backup.', 404);

  const filePath = path.join(BACKUPS_ROOT, backup.folder, safeName);
  if (!fs.existsSync(filePath)) throw new AppError('Backup file is missing from disk.', 404);

  res.download(filePath, safeName);
});

module.exports = { listBackups, createBackup, downloadBackupFile };
