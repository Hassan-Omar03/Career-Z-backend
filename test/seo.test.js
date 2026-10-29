const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Super Admin Comments & Ratings Management: every rating in one place, hide / show / edit / delete,
process.env.NODE_ENV = 'test';
process.env.SEO_TEMPLATE_PATH = require('path').join(__dirname, 'fixtures-seo-shell.html');
require('fs').writeFileSync(process.env.SEO_TEMPLATE_PATH, '<!doctype html><html><head><!--seo:head--><title>x</title><!--/seo:head--></head><body><div id="root"><!--seo:body--><!--/seo:body--></div></body></html>');
process.env.DISABLE_SUBSCRIPTION_LIMITS = 'true';
const emailService = require('../src/services/email.service');
mock.method(emailService, 'sendEmail', async () => ({ ok: true }));
const app = require('../src/app');
const env = require('../src/config/env');
const model = (n) => require(`../src/models/${n}`);
let mongo, server, base, school;
const u = {};
const tok = (x) => jwt.sign({ sub: String(x._id) }, env.jwt.accessSecret, { expiresIn: '30m' });
async function api(who, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tok(u[who])}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers };
}
const expect = (res, code, msg = '') => assert.equal(res.status, code, `${msg} → ${(res.text || '').slice(0, 300)}`);
async function account(name, role) {
  u[name] = await model('User').create({ fullName: `${name} Khan`, email: `${name.toLowerCase()}@seo.test`, passwordHash: 'x', emailVerified: true, roles: [role], status: 'active', country: 'PK', city: 'Lahore' });
  await model('RoleRequest').create({ user: u[name]._id, requestedRole: role, status: 'approved' });
  await model('UserProfile').create({ user: u[name]._id, role, completed: true, percent: 100 });
}
const S = {};
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await account('Emp', 'employer');
  await account('Writer', 'super_admin');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  S.job = await model('Job').create({ postedBy: u.Emp._id, title: 'Physics Teacher', company: 'Beaconhouse', city: 'Lahore', country: 'PK', type: 'full_time', status: 'active', salaryMin: 80000, salaryMax: 120000, currency: 'PKR', skills: ['Physics', 'O Levels'], description: 'Teach O Level physics to grade 9 and 10.' });
  S.post = await model('BlogPost').create({ slug: 'how-to-win-a-scholarship', title: 'How to win a scholarship in 2026', excerpt: 'Seven steps that work.', content: '<p>Start early.</p><p>Write a strong essay.</p>', status: 'published', author: u.Writer._id, publishedAt: new Date(), category: 'Scholarships' });
});
after(async () => { await new Promise((r) => server.close(r)); await mongoose.disconnect(); await mongo.stop(); require('fs').rmSync(process.env.SEO_TEMPLATE_PATH, { force: true }); });

test('a job page: own title, canonical, JobPosting schema and readable text', async () => {
  const r = await api(null, 'GET', `/seo/render?path=/jobs/${S.job._id}`);
  expect(r, 200);
  assert.match(r.text, /<title>Physics Teacher job at Beaconhouse in Lahore, Pakistan \| CareerZ\.pk<\/title>/);
  assert.match(r.text, new RegExp(`<link rel="canonical" href="https://careerz.pk/jobs/${S.job._id}"/>`));
  const ld = JSON.parse(r.text.match(/<script id="page-schema"[^>]*>(.*?)<\/script>/)[1]);
  const job = ld['@graph'].find((n) => n['@type'] === 'JobPosting');
  assert.equal(job.hiringOrganization.name, 'Beaconhouse');
  assert.equal(job.employmentType, 'FULL_TIME');
  assert.equal(job.baseSalary.value.minValue, 80000);
  assert.equal(job.jobLocation.address.addressLocality, 'Lahore');
  assert.match(r.text, /<h1>Physics Teacher<\/h1>/);
  assert.match(r.text, /jobs in Lahore/);
});

test('a blog post: BlogPosting schema; a missing page is 404 and noindex', async () => {
  const r = await api(null, 'GET', '/seo/render?path=/blog/how-to-win-a-scholarship');
  expect(r, 200);
  assert.match(r.text, /"@type":"BlogPosting"/);
  assert.match(r.text, /<p>Write a strong essay\.<\/p>/);
  const miss = await api(null, 'GET', '/seo/render?path=/jobs/6ae3000000000000000000aa');
  expect(miss, 404);
  assert.match(miss.text, /noindex,follow/);
  assert.match((await api(null, 'GET', '/seo/render?path=/blog/<script>')).text, /noindex/);
});

test('sitemap lists every job and post; RSS lists posts', async () => {
  const s = await api(null, 'GET', '/seo/sitemap.xml');
  expect(s, 200);
  assert.match(s.text, new RegExp(`https://careerz.pk/jobs/${S.job._id}`));
  assert.match(s.text, /https:\/\/careerz.pk\/blog\/how-to-win-a-scholarship/);
  assert.match(s.text, /<loc>https:\/\/careerz.pk\/scholarships<\/loc>/);
  const rss = await api(null, 'GET', '/seo/rss.xml');
  assert.match(rss.text, /<title>How to win a scholarship in 2026<\/title>/);
});

test('city landing pages: "Jobs in Lahore" lists the real jobs; an empty city is noindex', async () => {
  const r = await api(null, 'GET', '/seo/render?path=/jobs&city=Lahore');
  expect(r, 200);
  assert.match(r.text, /<title>Jobs in Lahore \d{4} \| CareerZ\.pk<\/title>/);
  assert.match(r.text, /<link rel="canonical" href="https:\/\/careerz.pk\/jobs\?city=Lahore"\/>/);
  assert.match(r.text, /"@type":"ItemList"/);
  assert.match(r.text, new RegExp(`/jobs/${S.job._id}`));
  assert.match((await api(null, 'GET', '/seo/render?path=/jobs&city=Quetta')).text, /noindex/);
  assert.match((await api(null, 'GET', '/seo/sitemap.xml')).text, /\/jobs\?city=Lahore/);
});

test('Urdu pages: /ur/… has Urdu title, rtl, its own canonical and hreflang both ways', async () => {
  const r = await api(null, 'GET', `/seo/render?path=/ur/jobs/${S.job._id}`);
  expect(r, 200);
  assert.match(r.text, /<html lang="ur" dir="rtl"/);
  assert.match(r.text, /<title>Lahore میں Physics Teacher کی نوکری – Beaconhouse \| CareerZ\.pk<\/title>/);
  assert.match(r.text, new RegExp(`<link rel="canonical" href="https://careerz.pk/ur/jobs/${S.job._id}"/>`));
  assert.match(r.text, new RegExp(`hreflang="en" href="https://careerz.pk/jobs/${S.job._id}"`));
  const en = await api(null, 'GET', `/seo/render?path=/jobs/${S.job._id}`);
  assert.match(en.text, new RegExp(`hreflang="ur" href="https://careerz.pk/ur/jobs/${S.job._id}"`));
  assert.match((await api(null, 'GET', '/seo/render?path=/ur/jobs&city=Lahore')).text, /Lahore میں نوکریاں \d{4}/);
  const sm = (await api(null, 'GET', '/seo/sitemap.xml')).text;
  assert.match(sm, new RegExp(`<loc>https://careerz.pk/ur/jobs/${S.job._id}</loc>`));
  assert.match(sm, /xhtml:link rel="alternate" hreflang="ur"/);
});

test('every page has its own share card image (PNG made from CareerZ data)', async () => {
  const r = await api(null, 'GET', `/seo/render?path=/jobs/${S.job._id}`);
  assert.ok(r.text.includes(`og:image" content="https://careerz.pk/api/seo/og.png?path=%2Fjobs%2F${S.job._id}"`), "own share card");
  const res = await fetch(`${base}/seo/og.png?path=/jobs/${S.job._id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  assert.equal(buf.readUInt32BE(16), 1200);
  assert.equal(buf.readUInt32BE(20), 630);
  const ur = await fetch(`${base}/seo/og.png?path=/ur/jobs/${S.job._id}&lang=ur`);
  assert.equal(ur.status, 200);
});
