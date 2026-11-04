const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
process.env.NODE_ENV = 'test';
const file = path.join(os.tmpdir(), `shell-${process.pid}.html`);
fs.writeFileSync(file, '<html lang="en"><head><!--seo:head--><title>x</title><!--/seo:head--></head><body><div id="root"><!--seo:body--><!--/seo:body--></div></body></html>');
process.env.SEO_TEMPLATE_PATH = file;
const notifications = require('../src/services/notification.service');
mock.method(notifications, 'notify', async () => {});
mock.method(notifications, 'notifyAdmins', async () => {});
const seo = require('../src/services/seo.service');
const fl = require('../src/services/freelance.service');
const User = require('../src/models/User');
let mongo, seller, service, hidden;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  seller = await User.create({ fullName: 'Ayesha Khan', email: 'a@seo.test', passwordHash: 'x', roles: ['teacher'], status: 'active', city: 'Lahore' });
  await fl.saveProfile(seller, { type: 'Trainer', headline: 'Maths teacher', about: 'Ten years teaching.', skills: ['Maths'] });
  service = await fl.createService(seller, { title: 'Online maths tuition', category: 'online_tuition', description: 'Clear lessons <script>alert(1)</script> for matric.', image: 'https://cdn.test/a.png', packages: [{ tier: 'basic', price: 5000, deliveryDays: 30, revisions: 1 }, { tier: 'premium', price: 45000, deliveryDays: 300, revisions: 5 }] });
  hidden = await fl.createService(seller, { title: 'Paused writing help', category: 'writing', description: 'Help with writing for students.', packages: [{ tier: 'basic', price: 100, deliveryDays: 2 }] });
  await fl.setServiceStatus(seller, hidden._id, 'paused');
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); fs.rmSync(file, { force: true }); });

test('a service page has its own title, description, canonical link, schema and readable text', async () => {
  const { status, html } = await seo.render(`/freelance/${service._id}`);
  assert.equal(status, 200);
  assert.match(html, /<title>Online maths tuition from PKR 5,000 in Lahore/);
  assert.match(html, new RegExp(`rel="canonical" href="[^"]*/freelance/${service._id}"`));
  assert.match(html, /"@type":"Service"/);
  assert.match(html, /"@type":"AggregateOffer"/);
  assert.match(html, /"lowPrice":5000/);
  assert.match(html, /"highPrice":45000/);
  assert.match(html, /index,follow/);
  assert.match(html, /Ayesha Khan/);
  assert.match(html, /<h1>Online maths tuition/);
  assert.ok(!html.includes('<script>alert(1)'), 'text from users cannot run');
});

test('the freelancer page and the Urdu page have their own details', async () => {
  const person = await seo.render(`/freelancer/${seller._id}`);
  assert.equal(person.status, 200);
  assert.match(person.html, /<title>Ayesha Khan – Trainer in Lahore/);
  assert.match(person.html, /"@type":"Person"/);
  const urdu = await seo.render(`/ur/freelance/${service._id}`);
  assert.equal(urdu.status, 200);
  assert.match(urdu.html, /lang="ur"/);
  assert.match(urdu.html, /سے شروع/);
});

test('hidden or missing services are not indexed, and the sitemap lists only live ones', async () => {
  const paused = await seo.render(`/freelance/${hidden._id}`);
  assert.equal(paused.status, 404);
  assert.match(paused.html, /noindex/);
  assert.equal((await seo.render('/freelance/not-an-id')).status, 404);
  let map = await seo.sitemap();
  assert.ok(map.includes(`/freelance/${service._id}`));
  assert.ok(map.includes(`/freelancer/${seller._id}`));
  assert.ok(map.includes('/freelance</loc>'));
  assert.ok(!map.includes(String(hidden._id)));
  await User.updateOne({ _id: seller._id }, { status: 'suspended' });
  assert.equal((await seo.render(`/freelance/${service._id}`)).status, 404, 'a suspended seller leaves the index');
  map = await seo.sitemap();
  assert.ok(!map.includes(String(service._id)));
  await User.updateOne({ _id: seller._id }, { status: 'active' });
});
