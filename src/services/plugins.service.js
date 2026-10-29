const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const mongoose = require('mongoose');
const Plugin = require('../models/Plugin');
const Setting = require('../models/Setting');
const AppError = require('../utils/AppError');

// Plugin System (master, Super Admin dashboard): list, add, enable/disable and delete plugins.
//   1. Modules: optional CareerZ features the Super Admin switches on or off. A module that is
//      off answers "turned off" on its API (admins still get through to settle open work) and
//      leaves the menus.
//   2. Integrations: outside apps (CRM, Slack, Zapier, an ERP…) receive CareerZ events as a
//      signed JSON POST to their own https address. No outside code ever runs inside CareerZ,
//      private / local addresses are refused, and a plugin that keeps failing turns itself off.

const fail = (message, status = 422) => new AppError(message, status);
const KEY = 'plugin_modules';
const MODULES = {
  marketplace: { label: 'Marketplace', description: 'Buy and sell books, notes, uniforms and digital products with escrow.', path: '/marketplace' },
  academy: { label: 'Academy batches', description: 'Academies run courses in batches with rosters, fees and waitlists.', path: '/academy' },
  visa: { label: 'Visa Center', description: 'Country rules, verified visa consultants, visa case tracking.', path: '/visa' },
  mock_interview: { label: 'AI Mock Interview', description: 'Candidates practise interviews with AI scoring and confidence levels.', path: '/mock-interviews' },
  virtual_fairs: { label: 'Virtual fairs', description: 'Online education and job fairs.', path: '/virtual-fairs' },
  forum: { label: 'Forum', description: 'Community questions and answers.', path: '/forum' },
  magazine: { label: 'Magazine', description: 'Institute magazines.', path: '/magazine' },
  study_groups: { label: 'Study groups', description: 'Student study groups.', path: '/study-groups' },
  polls: { label: 'Polls', description: 'Institute polls and surveys.', path: '/polls' },
  transport: { label: 'Transport tracking', description: 'School bus routes and live tracking.', path: '/transport' }
};
const EVENTS = {
  'user.registered': 'A new account signs up',
  'job.published': 'A job goes live',
  'job_application.created': 'Someone applies to a job',
  'order.placed': 'A marketplace order is placed',
  'payment.approved': 'CareerZ verifies a payment',
  'plugin.test': 'Test event (sent by the Test button)'
};

// ---------------------------------------------------------------- modules
let cache = null, cachedAt = 0;
async function modules() {
  if (!cache || Date.now() - cachedAt > 30000) {
    const s = await Setting.findOne({ key: KEY }).lean();
    cache = { ...Object.fromEntries(Object.keys(MODULES).map((k) => [k, true])), ...(s?.value || {}) };
    cachedAt = Date.now();
  }
  return cache;
}
async function moduleList() {
  const on = await modules();
  return Object.entries(MODULES).map(([key, m]) => ({ key, ...m, enabled: on[key] !== false }));
}
async function setModule(admin, key, enabled) {
  if (!admin.roles?.includes('super_admin')) throw fail('Only the Super Admin turns modules on or off.', 403);
  if (!MODULES[key]) throw fail('Unknown module.', 404);
  const value = { ...(await modules()), [key]: Boolean(enabled) };
  await Setting.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  cache = null;
  return moduleList();
}
// Express middleware for a module's routes.
function moduleGate(key) {
  return async (req, res, next) => {
    try {
      if ((await modules())[key] !== false) return next();
      const { optionalAuth } = require('../middleware/auth');
      return optionalAuth(req, res, () => {
        if (req.user?.roles?.some((r) => ['admin', 'super_admin', 'platform_staff'].includes(r))) return next();
        return res.status(503).json({ success: false, message: `${MODULES[key].label} is turned off on CareerZ right now.`, module: key });
      });
    } catch (e) { return next(e); }
  };
}

// ---------------------------------------------------------------- integrations
const PRIVATE4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^22[4-9]\./, /^2[3-5]\d\./];
const isPrivate = (ip) => (net.isIPv6(ip) ? /^(::1?$|f[cd]|fe[89ab]|::ffff:(10|127|192\.168|169\.254)\.)/i.test(ip) : PRIVATE4.some((r) => r.test(ip)));
async function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw fail('Enter the full https address of the integration.'); }
  if (u.protocol !== 'https:') throw fail('The address must start with https://.');
  if (u.username || u.password) throw fail('Do not put a password in the address.');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) throw fail('Local addresses are not allowed.');
  if (process.env.NODE_ENV !== 'test') {
    const ips = net.isIP(u.hostname) ? [u.hostname] : (await dns.lookup(u.hostname, { all: true }).catch(() => [])).map((a) => a.address);
    if (!ips.length) throw fail('That address cannot be found.');
    if (ips.some(isPrivate)) throw fail('Private network addresses are not allowed.');
  } else if (net.isIP(u.hostname) && isPrivate(u.hostname)) throw fail('Private network addresses are not allowed.');
  return u.toString();
}
const view = (p) => { const o = p.toObject ? p.toObject() : { ...p }; delete o.secret; o.deliveries = (o.deliveries || []).slice(-20).reverse(); return o; };
const superOnly = (admin) => { if (!admin.roles?.includes('super_admin')) throw fail('Only the Super Admin manages plugins.', 403); };

async function list() { return (await Plugin.find().sort({ createdAt: -1 }).lean()).map(view); }
async function create(admin, body = {}) {
  superOnly(admin);
  const name = String(body.name || '').trim().slice(0, 80);
  if (name.length < 2) throw fail('Give the plugin a name.');
  const events = [...new Set([].concat(body.events || []).filter((e) => EVENTS[e] && e !== 'plugin.test'))];
  if (!events.length) throw fail('Choose at least one event to send.');
  const secret = `czwh_${crypto.randomBytes(24).toString('hex')}`;
  const p = await Plugin.create({ name, description: String(body.description || '').trim().slice(0, 300), url: await safeUrl(body.url), events, secret, createdBy: admin._id });
  return { ...view(p), secret }; // shown once
}
async function update(admin, id, body = {}) {
  superOnly(admin);
  const p = await Plugin.findById(mongoose.isValidObjectId(id) ? id : null);
  if (!p) throw fail('Plugin not found.', 404);
  if (body.name !== undefined) { p.name = String(body.name).trim().slice(0, 80); if (p.name.length < 2) throw fail('Give the plugin a name.'); }
  if (body.description !== undefined) p.description = String(body.description).trim().slice(0, 300);
  if (body.url !== undefined) p.url = await safeUrl(body.url);
  if (body.events !== undefined) { p.events = [...new Set([].concat(body.events).filter((e) => EVENTS[e] && e !== 'plugin.test'))]; if (!p.events.length) throw fail('Choose at least one event to send.'); }
  if (body.enabled !== undefined) { p.enabled = Boolean(body.enabled); if (p.enabled) p.failures = 0; }
  let secret;
  if (body.rotateSecret) { secret = `czwh_${crypto.randomBytes(24).toString('hex')}`; p.secret = secret; }
  await p.save();
  return secret ? { ...view(p), secret } : view(p);
}
async function remove(admin, id) { superOnly(admin); await Plugin.deleteOne({ _id: id }); return { deleted: true }; }

// One signed POST. Header X-CareerZ-Signature = sha256=HMAC(secret, `${timestamp}.${body}`).
async function deliver(p, event, data) {
  const body = JSON.stringify({ id: crypto.randomUUID(), event, createdAt: new Date().toISOString(), data });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', p.secret).update(`${ts}.${body}`).digest('hex');
  const t0 = Date.now();
  let status = 0, error = '';
  try {
    await safeUrl(p.url); // DNS may have changed since the plugin was saved
    const res = await fetch(p.url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', 'User-Agent': 'CareerZ-Plugins/1', 'X-CareerZ-Event': event, 'X-CareerZ-Timestamp': ts, 'X-CareerZ-Signature': `sha256=${sig}` }, body, signal: AbortSignal.timeout(8000) });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) { error = String(e.message || e).slice(0, 200); }
  const ok = !error;
  const update = { $push: { deliveries: { $each: [{ event, status, ok, error, ms: Date.now() - t0 }], $slice: -50 } }, $set: { lastDeliveryAt: new Date() } };
  if (ok) update.$set.failures = 0; else update.$inc = { failures: 1 };
  const after = await Plugin.findByIdAndUpdate(p._id, update, { new: true });
  if (after && after.failures >= 20 && after.enabled) {
    await Plugin.updateOne({ _id: p._id }, { $set: { enabled: false } });
    require('./notification.service').notifyAdmins?.({ title: `Plugin turned off: ${p.name}`, body: 'It failed 20 times in a row. Check its address and turn it on again.' }).catch?.(() => {});
  }
  return { ok, status, error };
}
async function test(admin, id) {
  superOnly(admin);
  const p = await Plugin.findById(mongoose.isValidObjectId(id) ? id : null).select('+secret');
  if (!p) throw fail('Plugin not found.', 404);
  return deliver(p, 'plugin.test', { message: 'Hello from CareerZ. Your plugin is connected.' });
}

// Fire-and-forget: never slows down or breaks the action that caused the event.
function emit(event, data) {
  if (!EVENTS[event]) return;
  setImmediate(async () => {
    try {
      const plugins = await Plugin.find({ enabled: true, events: event }).select('+secret');
      await Promise.all(plugins.map((p) => deliver(p, event, data)));
    } catch { /* plugins never break CareerZ */ }
  });
}

module.exports = { MODULES, EVENTS, modules, moduleList, setModule, moduleGate, list, create, update, remove, test, emit, deliver, safeUrl };
