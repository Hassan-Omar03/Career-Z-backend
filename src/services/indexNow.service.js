const Setting = require('../models/Setting');
const M = (n) => require(`../models/${n}`);

// IndexNow: tells Bing, Yandex, Seznam, Naver and the other IndexNow search engines about new,
// changed and removed CareerZ pages within minutes, without waiting for them to crawl.
// Every 10 minutes the pages changed since the last run (English and Urdu addresses) are sent in
// one request. The key file is served by the website at https://careerz.pk/<key>.txt.

const KEY = () => process.env.INDEXNOW_KEY || '2fa3f5920583b019d5ba32b967ed017e';
const SITE = () => (process.env.PUBLIC_SITE_URL || 'https://careerz.pk').replace(/\/$/, '');
const STATE = 'indexnow_state';
const STATIC = ['/', '/jobs', '/scholarships', '/institutes', '/courses', '/marketplace', '/donors', '/visa', '/blog', '/about', '/contact', '/faq', '/help', '/careers', '/partnership', '/advertise', '/press', '/news', '/agent-program', '/donor-program', '/become-a-seller', '/privacy', '/terms', '/cookies', '/refund', '/cancellation', '/community-guidelines', '/code-of-conduct', '/accessibility'];
const both = (p) => [p, `/ur${p === '/' ? '' : p}`];

// Public addresses of everything changed since `since` (removed items are included, so search
// engines drop them too).
async function changedPaths(since) {
  const q = since ? { updatedAt: { $gt: since } } : {};
  const take = async (model, filter, fields, toPath) => { try { return (await M(model).find({ ...q, ...filter }).select(fields).limit(5000).lean()).map(toPath).filter(Boolean); } catch { return []; } };
  const lists = await Promise.all([
    take('Job', {}, '_id', (d) => `/jobs/${d._id}`),
    take('Product', { status: { $ne: 'draft' } }, '_id', (d) => `/marketplace/${d._id}`),
    take('Scholarship', {}, '_id', (d) => `/scholarships/${d._id}`),
    take('Institution', { verificationStatus: 'approved' }, '_id', (d) => `/institutes/${d._id}`),
    take('Course', { published: true }, '_id', (d) => `/courses/${d._id}`),
    take('BlogPost', {}, 'slug', (d) => `/blog/${d.slug}`),
    take('Page', {}, 'slug', (d) => `/${d.slug}`),
    take('DonorPublicProfile', {}, 'user', (d) => d.user && `/donors/${d.user}`),
    take('TeacherProfile', { publicPortfolio: true }, 'user', (d) => d.user && `/teacher/${d.user}`)
  ]);
  const home = since ? await Setting.exists({ key: 'site_content_home', updatedAt: { $gt: since } }).catch(() => null) : true;
  return [...new Set([...(since ? [] : STATIC), ...(home && since ? ['/'] : []), ...lists.flat()].flatMap(both))];
}

async function submit(paths) {
  const urlList = [...new Set(paths)].slice(0, 10000).map((p) => SITE() + p);
  if (!urlList.length) return { ok: true, count: 0, status: 0 };
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: new URL(SITE()).host, key: KEY(), keyLocation: `${SITE()}/${KEY()}.txt`, urlList }),
    signal: AbortSignal.timeout(15000)
  });
  // 200 and 202 mean accepted.
  return { ok: res.status === 200 || res.status === 202, count: urlList.length, status: res.status };
}

async function run({ all = false } = {}) {
  const state = (await Setting.findOne({ key: STATE }).lean())?.value || {};
  const startedAt = new Date();
  const since = all || !state.lastRun ? null : new Date(state.lastRun);
  let result;
  try { result = await submit(await changedPaths(since)); } catch (e) { result = { ok: false, count: 0, status: 0, error: String(e.message || e).slice(0, 200) }; }
  const value = { ...state, lastAttempt: startedAt, lastResult: result, totalSubmitted: (state.totalSubmitted || 0) + (result.ok ? result.count : 0) };
  if (result.ok) value.lastRun = startedAt; // a failed send is retried with the same pages next time
  if (result.ok && result.count) value.lastSubmitted = startedAt;
  await Setting.findOneAndUpdate({ key: STATE }, { $set: { value } }, { upsert: true });
  return value;
}

async function status() {
  return { key: KEY(), keyLocation: `${SITE()}/${KEY()}.txt`, ...((await Setting.findOne({ key: STATE }).lean())?.value || {}) };
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV !== 'production' || process.env.INDEXNOW_DISABLED === 'true') return;
  setTimeout(() => run().catch(() => {}), 60 * 1000);
  timer = setInterval(() => run().catch(() => {}), 10 * 60 * 1000);
  timer.unref?.();
}

module.exports = { run, status, start, changedPaths, submit, KEY };
