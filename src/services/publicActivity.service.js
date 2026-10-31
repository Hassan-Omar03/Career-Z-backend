const listings = require('./publicListings.service');
const publicHome = require('./publicHome.service');

// Live activity for the home page pop-ups ("New job posted by …"): the newest public jobs,
// scholarships, courses, marketplace listings, institutes and blog posts. Only what is already
// public on the site, never private people's names. Cached for two minutes.

let cache = { at: 0, items: [] };
const take = async (fn) => { try { return (await fn()).items || []; } catch { return []; } };

async function activity() {
  if (Date.now() - cache.at < 120000) return cache.items;
  const page = { limit: 6 };
  const [jobs, scholarships, courses, products, institutes] = await Promise.all([
    take(() => listings.listJobs(page)), take(() => listings.listScholarships(page)), take(() => publicHome.listCourses(page)),
    take(() => listings.listProducts(page)), take(() => listings.listInstitutes(page))
  ]);
  const posts = await require('../models/BlogPost').find({ status: 'published' }).select('slug title publishedAt createdAt').sort({ publishedAt: -1 }).limit(4).lean().catch(() => []);
  const items = [
    ...jobs.map((j) => ({ kind: 'job', label: 'New job', text: `${j.title} at ${j.company}${j.city ? `, ${j.city}` : ''}`, link: `/jobs/${j._id}`, at: j.postedAt })),
    ...scholarships.map((s) => ({ kind: 'scholarship', label: 'New scholarship', text: `${s.title}${s.provider?.name ? ` by ${s.provider.name}` : ''}`, link: `/scholarships/${s._id}`, at: s.postedAt })),
    ...courses.map((c) => ({ kind: 'course', label: 'New course', text: `${c.title}${c.institution?.name || c.teacher?.name ? ` by ${c.institution?.name || c.teacher?.name}` : ''}`, link: `/courses/${c._id}`, at: c.postedAt })),
    ...products.map((p) => ({ kind: 'product', label: 'New in marketplace', text: `${p.title}${p.seller?.city ? ` in ${p.seller.city}` : ''}`, link: `/marketplace/${p._id}`, at: p.postedAt })),
    ...institutes.map((i) => ({ kind: 'institute', label: 'Now on CareerZ', text: `${i.name}${i.city ? `, ${i.city}` : ''}`, link: `/institutes/${i._id}`, at: i.createdAt || null })),
    ...posts.map((b) => ({ kind: 'blog', label: 'New on the blog', text: b.title, link: `/blog/${b.slug}`, at: b.publishedAt || b.createdAt }))
  ].filter((x) => x.text).sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)).slice(0, 20);
  cache = { at: Date.now(), items };
  return items;
}

module.exports = { activity };
