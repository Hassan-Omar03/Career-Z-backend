const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('../config/env');

// Uploaded files live in Cloudinary (or another HTTPS store); the database only holds their URLs.
// A backup therefore also copies the actual file bytes, so a deleted/lost upload can be restored.

const UPLOAD_URL = /https:\/\/res\.cloudinary\.com\/[^\s"'<>)\\]+/g;
const MAX_FILE_BYTES = Number(process.env.BACKUP_MAX_FILE_MB || 100) * 1024 * 1024;
const MAX_TOTAL_BYTES = Number(process.env.BACKUP_MAX_TOTAL_MB || 2048) * 1024 * 1024;

// Every uploaded-file URL referenced anywhere in the dumped collections, with which documents use it.
function collectUploadUrls(collections) {
  const refs = new Map();
  for (const { name, documents } of collections) {
    for (const doc of documents) {
      const text = JSON.stringify(doc);
      for (const url of new Set(text.match(UPLOAD_URL) || [])) {
        if (!refs.has(url)) refs.set(url, []);
        refs.get(url).push({ collection: name, id: String(doc._id) });
      }
    }
  }
  return refs;
}

const keyFor = (url) => crypto.createHash('sha1').update(url).digest('hex');

// Downloads each referenced file into <folder>/files/ and writes files-manifest.json.
async function backupFiles(folderPath, collections, fetchImpl = fetch) {
  const refs = collectUploadUrls(collections);
  const dir = path.join(folderPath, 'files');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = [];
  let total = 0;
  for (const [url, usedBy] of refs) {
    const entry = { url, key: keyFor(url), usedBy, status: 'saved', size: 0, contentType: '', sha256: '' };
    try {
      if (total >= MAX_TOTAL_BYTES) throw new Error('backup size limit reached');
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_FILE_BYTES) throw new Error('file larger than the per-file backup limit');
      fs.writeFileSync(path.join(dir, entry.key), bytes);
      Object.assign(entry, { size: bytes.length, contentType: response.headers.get('content-type') || 'application/octet-stream', sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      total += bytes.length;
    } catch (error) {
      Object.assign(entry, { status: 'failed', error: error.message });
    }
    manifest.push(entry);
  }
  fs.writeFileSync(path.join(folderPath, 'files-manifest.json'), JSON.stringify(manifest, null, 2));
  return { count: manifest.filter((m) => m.status === 'saved').length, failed: manifest.filter((m) => m.status === 'failed').length, sizeBytes: total };
}

function readManifest(folderPath) {
  const file = path.join(folderPath, 'files-manifest.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

// Uploads bytes to the platform Cloudinary account (signed server-side upload).
async function uploadToPlatform(bytes, contentType, fetchImpl = fetch) {
  const { cloudName, apiKey, apiSecret } = env.cloudinary;
  if (!cloudName || !apiKey || !apiSecret) throw new Error('Platform storage (CLOUDINARY_*) is not configured.');
  const timestamp = Math.round(Date.now() / 1000);
  const folder = 'careerz-restored';
  const signature = crypto.createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${apiSecret}`).digest('hex');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }));
  form.append('api_key', apiKey); form.append('timestamp', String(timestamp)); form.append('folder', folder); form.append('signature', signature);
  const response = await fetchImpl(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.secure_url) throw new Error(payload.error?.message || `upload failed (${response.status})`);
  return payload.secure_url;
}

// Replaces every occurrence of `from` with `to` inside a plain document (deep).
function replaceDeep(value, from, to) {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((v) => replaceDeep(v, from, to));
  if (value && typeof value === 'object' && !(value instanceof Date) && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceDeep(v, from, to)]));
  }
  return value;
}

module.exports = { collectUploadUrls, backupFiles, readManifest, uploadToPlatform, replaceDeep, keyFor };
