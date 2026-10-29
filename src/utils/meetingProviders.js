const AppError = require('./AppError');

// Where an online interview happens (master 12.9 Interview Center). CareerZ's own video room is
// the default; the organiser may instead use Google Meet, Zoom, Microsoft Teams or any custom
// meeting link. External links must be https and, for the named services, on that service.
const PROVIDERS = {
  careerz: { label: 'CareerZ video', hosts: null },
  google_meet: { label: 'Google Meet', hosts: ['meet.google.com'] },
  zoom: { label: 'Zoom', hosts: ['zoom.us', 'zoom.com'] },
  teams: { label: 'Microsoft Teams', hosts: ['teams.microsoft.com', 'teams.live.com'] },
  custom: { label: 'Custom meeting link', hosts: [] }
};

function onHost(hostname, hosts) {
  return hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

// Returns { provider, externalUrl } after checking the link fits the chosen provider.
function normalise(provider, externalUrl) {
  const key = PROVIDERS[provider] ? provider : 'careerz';
  if (key === 'careerz') return { provider: 'careerz', externalUrl: '' };
  const raw = String(externalUrl || '').trim();
  if (!raw) throw new AppError(`Paste the ${PROVIDERS[key].label} meeting link.`, 422);
  let url;
  try { url = new URL(raw); } catch { throw new AppError('Enter a full meeting link starting with https://', 422); }
  if (url.protocol !== 'https:') throw new AppError('The meeting link must start with https://', 422);
  const { hosts } = PROVIDERS[key];
  if (hosts.length && !onHost(url.hostname.toLowerCase(), hosts)) throw new AppError(`That is not a ${PROVIDERS[key].label} link.`, 422);
  return { provider: key, externalUrl: url.toString() };
}

module.exports = { PROVIDERS, normalise };
