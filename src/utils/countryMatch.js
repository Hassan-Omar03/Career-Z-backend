const Country = require('../models/Country');

// Audit BUG-001: records keep a country as a code ("PK") or a name ("Pakistan", "PAKISTAN"). A filter
// for either form matches all of them: the typed value is looked up in the country list and every
// spelling of that country (code and name, any case) is accepted. Unknown text is matched as typed.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function countryMatch(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return null;
  const re = new RegExp('^' + escape(v) + '$', 'i');
  const hits = await Country.find({ $or: [{ code: re }, { name: re }] }).select('code name').lean().catch(() => []);
  const forms = new Set([v, ...hits.flatMap((c) => [c.code, c.name])].filter(Boolean));
  return new RegExp('^(' + [...forms].map(escape).join('|') + ')$', 'i');
}

module.exports = { countryMatch };
