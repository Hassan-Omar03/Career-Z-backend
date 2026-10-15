const AppError = require('./AppError');

// Accreditation, affiliations, social links and map location an institution publishes on its
// profile. Everything is validated here so the public page never shows a broken or unsafe link.

const SOCIAL = {
  facebook: /(^|\.)facebook\.com$|(^|\.)fb\.com$/,
  instagram: /(^|\.)instagram\.com$/,
  linkedin: /(^|\.)linkedin\.com$/,
  x: /(^|\.)x\.com$|(^|\.)twitter\.com$/,
  youtube: /(^|\.)youtube\.com$|(^|\.)youtu\.be$/,
  tiktok: /(^|\.)tiktok\.com$/,
  whatsapp: /(^|\.)wa\.me$|(^|\.)whatsapp\.com$/
};
const AFFILIATION_KINDS = ['university', 'board', 'government', 'association', 'partner', 'other'];
const text = (v, max) => String(v ?? '').trim().slice(0, max);

function httpsUrl(value, label) {
  const v = text(value, 500);
  if (!v) return '';
  let url;
  try { url = new URL(v); } catch { throw new AppError(`${label}: enter a full link starting with https://`, 422); }
  if (url.protocol !== 'https:') throw new AppError(`${label}: the link must start with https://`, 422);
  return url.href;
}

function socialLinks(input = {}) {
  const out = {};
  for (const [key, hostRule] of Object.entries(SOCIAL)) {
    const href = httpsUrl(input[key], `${key[0].toUpperCase()}${key.slice(1)} link`);
    if (href && !hostRule.test(new URL(href).hostname.toLowerCase())) throw new AppError(`The ${key} link must be a ${key} address.`, 422);
    out[key] = href;
  }
  return out;
}

function accreditations(list) {
  if (!Array.isArray(list)) throw new AppError('Accreditations must be a list.', 422);
  if (list.length > 20) throw new AppError('Add at most 20 accreditations.', 422);
  return list.map((a, i) => {
    const body = text(a?.body, 160);
    if (!body) throw new AppError(`Accreditation ${i + 1}: enter the accrediting body.`, 422);
    let validUntil = null;
    if (a.validUntil) { validUntil = new Date(a.validUntil); if (Number.isNaN(validUntil.getTime())) throw new AppError(`Accreditation ${i + 1}: the "valid until" date is not a date.`, 422); }
    return { body, reference: text(a.reference, 120), validUntil, documentUrl: httpsUrl(a.documentUrl, `Accreditation ${i + 1} certificate`) };
  });
}

function affiliations(list) {
  if (!Array.isArray(list)) throw new AppError('Affiliations must be a list.', 422);
  if (list.length > 20) throw new AppError('Add at most 20 affiliations.', 422);
  const year = new Date().getFullYear();
  return list.map((a, i) => {
    const name = text(a?.name, 160);
    if (!name) throw new AppError(`Affiliation ${i + 1}: enter the name.`, 422);
    const since = a.since ? Number(a.since) : null;
    if (since !== null && (!Number.isInteger(since) || since < 1800 || since > year)) throw new AppError(`Affiliation ${i + 1}: "since" must be a year between 1800 and ${year}.`, 422);
    return { name, kind: AFFILIATION_KINDS.includes(a.kind) ? a.kind : 'other', since };
  });
}

function location(input) {
  if (!input || (input.lat === '' && input.lng === '') || (input.lat == null && input.lng == null)) return { lat: null, lng: null };
  const lat = Number(input.lat), lng = Number(input.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new AppError('Map location: latitude must be between -90 and 90 and longitude between -180 and 180.', 422);
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

// Applies whichever of the four groups the request sent.
function applyProfileExtras(institution, body) {
  if (body.socialLinks !== undefined) institution.socialLinks = socialLinks(body.socialLinks || {});
  if (body.accreditations !== undefined) institution.accreditations = accreditations(body.accreditations || []);
  if (body.affiliations !== undefined) institution.affiliations = affiliations(body.affiliations || []);
  if (body.location !== undefined) institution.location = location(body.location);
}

// The public view of the same fields.
function publicProfileExtras(i) {
  const links = Object.fromEntries(Object.entries(i.socialLinks || {}).filter(([k, v]) => SOCIAL[k] && /^https:\/\//.test(v || '')));
  return {
    accreditations: (i.accreditations || []).map((a) => ({ body: a.body, reference: a.reference || '', validUntil: a.validUntil || null, documentUrl: a.documentUrl || '', current: !a.validUntil || new Date(a.validUntil) >= new Date() })),
    affiliations: (i.affiliations || []).map((a) => ({ name: a.name, kind: a.kind, since: a.since || null })),
    socialLinks: links,
    location: i.location?.lat != null && i.location?.lng != null ? { lat: i.location.lat, lng: i.location.lng } : null,
    address: i.address || ''
  };
}

module.exports = { applyProfileExtras, publicProfileExtras, AFFILIATION_KINDS, SOCIAL_NETWORKS: Object.keys(SOCIAL) };
