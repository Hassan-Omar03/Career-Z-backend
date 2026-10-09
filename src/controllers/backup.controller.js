const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Backup = require('../models/Backup');
const backupFilesService = require('../services/backupFiles.service');
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
    const dumped = [];
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
      dumped.push({ name, documents: docs });
    }

    // The actual uploaded files (not just their URLs) — see backupFiles.service.
    const files = await backupFilesService.backupFiles(folderPath, dumped);

    const backup = await Backup.create({
      folder, collections, totalSizeBytes: totalSizeBytes + files.sizeBytes, files, status: 'completed', createdBy: req.user._id
    });
    return created(res, backup, `Backup complete — ${modelNames.length} collections and ${files.count} uploaded file(s)${files.failed ? ` (${files.failed} could not be downloaded)` : ''}, ${((totalSizeBytes + files.sizeBytes) / 1024).toFixed(1)} KB.`);
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

// GET /api/admin/backups/:id/uploads — the uploaded files captured in this backup.
const listBackupUploads = asyncHandler(async (req, res) => {
  const backup = await Backup.findById(req.params.id);
  if (!backup) throw new AppError('Backup not found.', 404);
  return ok(res, backupFilesService.readManifest(path.join(BACKUPS_ROOT, backup.folder)).map(({ url, key, size, contentType, status, error, usedBy }) => ({ url, key, size, contentType, status, error, usedBy: usedBy.length })));
});

// GET /api/admin/backups/:id/uploads/:key — download one backed-up file's original bytes.
const downloadBackupUpload = asyncHandler(async (req, res) => {
  const backup = await Backup.findById(req.params.id);
  if (!backup) throw new AppError('Backup not found.', 404);
  const folderPath = path.join(BACKUPS_ROOT, backup.folder);
  const entry = backupFilesService.readManifest(folderPath).find((m) => m.key === req.params.key && m.status === 'saved');
  if (!entry) throw new AppError('That file is not in this backup.', 404);
  const filePath = path.join(folderPath, 'files', path.basename(entry.key));
  if (!fs.existsSync(filePath)) throw new AppError('Backup file is missing from disk.', 404);
  res.type(entry.contentType || 'application/octet-stream');
  res.download(filePath, path.basename(new URL(entry.url).pathname) || entry.key);
});

// POST /api/admin/backups/:id/uploads/restore — { confirm: "RESTORE FILES <id>", onlyMissing?: true }
// Re-uploads backed-up files whose original URL no longer serves them, then rewrites every
// database reference from the dead URL to the new one. Without the confirmation it is a dry run.
const restoreBackupUploads = asyncHandler(async (req, res) => {
  const backup = await Backup.findById(req.params.id);
  if (!backup) throw new AppError('Backup not found.', 404);
  const folderPath = path.join(BACKUPS_ROOT, backup.folder);
  const manifest = backupFilesService.readManifest(folderPath).filter((m) => m.status === 'saved');
  const onlyMissing = req.body?.onlyMissing !== false;
  const candidates = [];
  for (const entry of manifest) {
    let missing = true;
    if (onlyMissing) {
      const head = await fetch(entry.url, { method: 'HEAD', signal: AbortSignal.timeout(15000) }).catch(() => null);
      missing = !head || !head.ok;
    }
    if (missing) candidates.push(entry);
  }
  if (req.body?.confirm !== `RESTORE FILES ${backup.id}`) {
    return ok(res, { dryRun: true, confirmationRequired: `RESTORE FILES ${backup.id}`, toRestore: candidates.map((c) => ({ url: c.url, usedBy: c.usedBy.length })) }, `${candidates.length} file(s) would be restored.`);
  }
  const restored = [];
  const failed = [];
  for (const entry of candidates) {
    try {
      const bytes = fs.readFileSync(path.join(folderPath, 'files', path.basename(entry.key)));
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('backup copy is corrupted');
      const newUrl = await backupFilesService.uploadToPlatform(bytes, entry.contentType);
      let documents = 0;
      for (const ref of entry.usedBy) {
        if (!mongoose.modelNames().includes(ref.collection)) continue;
        const Model = mongoose.model(ref.collection);
        const doc = await Model.findById(ref.id).lean();
        if (!doc) continue;
        const { _id, ...rest } = backupFilesService.replaceDeep(doc, entry.url, newUrl);
        await Model.collection.replaceOne({ _id: doc._id }, { _id: doc._id, ...rest });
        documents += 1;
      }
      restored.push({ from: entry.url, to: newUrl, documents });
    } catch (error) {
      failed.push({ url: entry.url, error: error.message });
    }
  }
  return ok(res, { restored, failed }, `${restored.length} file(s) restored${failed.length ? `, ${failed.length} failed` : ''}.`);
});

module.exports = { listBackups, createBackup, downloadBackupFile, listBackupUploads, downloadBackupUpload, restoreBackupUploads };
