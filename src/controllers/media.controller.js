const crypto = require('crypto');
const MediaCredential = require('../models/MediaCredential');
const { encrypt, decrypt } = require('../utils/encryption');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/apiResponse');

// GET /api/media/cloudinary/config
const getConfig = asyncHandler(async (req, res) => {
  const cred = await MediaCredential.findOne({ user: req.user._id });
  return ok(res, { configured: Boolean(cred), cloudName: cred?.cloudName || null });
});

// PUT /api/media/cloudinary/config
const saveConfig = asyncHandler(async (req, res) => {
  const { cloudName, apiKey, apiSecret } = req.body;
  if (!cloudName || !apiKey || !apiSecret) throw new AppError('cloudName, apiKey and apiSecret are required.', 422);

  await MediaCredential.findOneAndUpdate(
    { user: req.user._id },
    { user: req.user._id, provider: 'cloudinary', cloudName: cloudName.trim(), apiKey: apiKey.trim(), apiSecretEncrypted: encrypt(apiSecret.trim()) },
    { upsert: true, new: true, runValidators: true }
  );
  return ok(res, { configured: true }, 'Cloudinary connected.');
});

const removeConfig = asyncHandler(async (req, res) => {
  await MediaCredential.deleteOne({ user: req.user._id });
  return ok(res, null, 'Cloudinary disconnected.');
});

// POST /api/media/cloudinary/signature — signs an upload so the BROWSER can upload the large
// rendered video file directly to Cloudinary (never through our own server, which would hit
// request-size/timeout limits on serverless hosting). CareerZ never sees the file bytes.
const getUploadSignature = asyncHandler(async (req, res) => {
  const cred = await MediaCredential.findOne({ user: req.user._id });
  if (!cred) throw new AppError('No media storage connected yet — connect Cloudinary first (AI Settings → Video Storage).', 503);

  const timestamp = Math.round(Date.now() / 1000);
  const folder = 'careerz-lessons';
  const apiSecret = decrypt(cred.apiSecretEncrypted);

  // Cloudinary's documented signing rule: alphabetically-sorted name=value params (excluding
  // file/cloud_name/resource_type/api_key), joined with '&', api_secret appended with no
  // delimiter, then SHA-1 hashed.
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(paramsToSign).digest('hex');

  return ok(res, { signature, timestamp, folder, apiKey: cred.apiKey, cloudName: cred.cloudName });
});

module.exports = { getConfig, saveConfig, removeConfig, getUploadSignature };
