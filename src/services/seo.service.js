const fs = require('fs');
const mongoose = require('mongoose');
const listings = require('./publicListings.service');
const publicHome = require('./publicHome.service');

// Dynamic SEO. nginx sends the public detail pages (a job, course, institute, scholarship, product,
// donor, blog post, teacher portfolio, institute website) here; we return the normal app shell with
// that page's own title, description, canonical link, social tags, schema.org data (JobPosting,
// Course, Product, BlogPosting…) and a readable text copy of the page, so search engines see the
// real content without running JavaScript. The browser then starts the React app as usual, so
// visitors and crawlers get the same page. Also: the full sitemap and the blog RSS feed.

const SITE = () => (process.env.PUBLIC_SITE_URL || 'https://careerz.pk').replace(/\/$/, '');
const BRAND = 'CareerZ.pk';
const LOGO = () => `${SITE()}/logo2.png`;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const plain = (html, n = 0) => { const t = String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); return n && t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t; };
const iso = (d) => (d ? new Date(d).toISOString() : undefined);
const isId = (id) => mongoose.isValidObjectId(id);
const httpsImg = (u) => (/^https:\/\//.test(u || '') ? u : null);
const COUNTRY = { PK: 'Pakistan', AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar', GB: 'United Kingdom', US: 'United States', CA: 'Canada', AU: 'Australia', DE: 'Germany', MY: 'Malaysia', OM: 'Oman', KW: 'Kuwait', BH: 'Bahrain', CN: 'China', TR: 'Turkey' };
const countryName = (c) => COUNTRY[String(c || '').toUpperCase()] || c || '';
const place = (city, country) => [city, countryName(country)].filter(Boolean).join(', ');
const year = () => new Date().getFullYear();

// ---------------------------------------------------------------- the app shell
let shell = { at: 0, html: '' };
async function template() {
  if (shell.html && Date.now() - shell.at < 5 * 60000) return shell.html;
  const file = process.env.SEO_TEMPLATE_PATH || '/var/www/careerz-frontend/site/app.html';
  let html = '';
  try { html = fs.readFileSync(file, 'utf8'); } catch {
    try { const r = await fetch(`${SITE()}/app.html`, { signal: AbortSignal.timeout(5000) }); if (r.ok) html = await r.text(); } catch { /* no shell available */ }
  }
  if (!html.includes('<!--seo:head-->')) html = '';
  shell = { at: Date.now(), html };
  return html;
}

function headTags({ title, description, path, keywords = [], image, type = 'website', schema, noindex = false, extra = '', lang = 'en' }) {
  const url = SITE() + (lang === 'ur' ? `/ur${path === '/' ? '' : path}` : path);
  const alt = (l) => SITE() + (l === 'ur' ? `/ur${path === '/' ? '' : path}` : path);
  const full = `${title} | ${BRAND}`;
  const img = image || LOGO();
  return [
    `<title>${esc(full)}</title>`,
    `<meta name="description" content="${esc(description)}"/>`,
    keywords.length ? `<meta name="keywords" content="${esc([...new Set(keywords)].join(', '))}"/>` : '',
    `<meta name="robots" content="${noindex ? 'noindex,follow' : 'index,follow,max-image-preview:large,max-snippet:-1'}"/>`,
    `<link rel="canonical" href="${esc(url)}"/>`,
    noindex ? '' : `<link rel="alternate" hreflang="en" href="${esc(alt('en'))}"/><link rel="alternate" hreflang="ur" href="${esc(alt('ur'))}"/><link rel="alternate" hreflang="x-default" href="${esc(alt('en'))}"/>`,
    `<meta property="og:type" content="${type}"/>`, `<meta property="og:site_name" content="${BRAND}"/>`, `<meta property="og:locale" content="${lang === 'ur' ? 'ur_PK' : 'en_PK'}"/>`, `<meta property="og:locale:alternate" content="${lang === 'ur' ? 'en_PK' : 'ur_PK'}"/>`,
    `<meta property="og:title" content="${esc(full)}"/>`, `<meta property="og:description" content="${esc(description)}"/>`,
    `<meta property="og:url" content="${esc(url)}"/>`, `<meta property="og:image" content="${esc(img)}"/>`, '<meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/>', `<meta property="og:image:alt" content="${esc(title)}"/>`,
    '<meta name="twitter:card" content="summary_large_image"/>', `<meta name="twitter:title" content="${esc(full)}"/>`,
    `<meta name="twitter:description" content="${esc(description)}"/>`, `<meta name="twitter:image" content="${esc(img)}"/>`,
    extra,
    schema ? `<script id="page-schema" data-path="${esc(path)}" type="application/ld+json">${json(schema)}</script>` : ''
  ].filter(Boolean).join('');
}

const crumbs = (items) => ({ '@type': 'BreadcrumbList', itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: SITE() + path })) });
const graph = (...nodes) => ({ '@context': 'https://schema.org', '@graph': nodes.filter(Boolean) });
const org = { '@type': 'Organization', '@id': 'https://careerz.pk/#org', name: 'CareerZ', url: 'https://careerz.pk', logo: 'https://careerz.pk/logo2.png' };

function bodyHtml({ crumbs: c, h1, sub, paragraphs = [], facts = [], lists = [], links = [] }) {
  return `<main class="seo-snapshot">`
    + `<nav aria-label="Breadcrumb">${c.map(([n, p]) => `<a href="${esc(p)}">${esc(n)}</a>`).join(' / ')}</nav>`
    + `<h1>${esc(h1)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}`
    + (facts.length ? `<ul>${facts.filter(([, v]) => v || v === 0).map(([k, v]) => `<li><strong>${esc(k)}:</strong> ${esc(v)}</li>`).join('')}</ul>` : '')
    + paragraphs.filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('')
    + lists.filter((l) => l.items.length).map((l) => `<h2>${esc(l.title)}</h2><ul>${l.items.map((x) => `<li>${x.href ? `<a href="${esc(x.href)}">${esc(x.text)}</a>` : esc(x.text)}</li>`).join('')}</ul>`).join('')
    + `<nav aria-label="Explore CareerZ">${[['Jobs in Pakistan', '/jobs'], ['Scholarships', '/scholarships'], ['Institutes', '/institutes'], ['Online courses', '/courses'], ['Marketplace', '/marketplace'], ['Visa Center', '/visa'], ['Blog', '/blog'], ...links].map(([n, p]) => `<a href="${esc(p)}">${esc(n)}</a>`).join(' · ')}</nav>`
    + `</main>`;
}

// ---------------------------------------------------------------- Urdu pages and share cards
// /ur/… pages: the same page with an Urdu title, description and heading (the listing's own text
// stays as written), lang="ur" dir="rtl", and hreflang links between the two languages.
const UR_NOUN = { jobs: 'نوکریاں', institutes: 'اسکول، کالج اور یونیورسٹیاں', courses: 'آن لائن کورسز', scholarships: 'اسکالرشپس', marketplace: 'کتابیں، نوٹس اور یونیفارم' };
const UR_LABEL = { job: 'نوکری', institute: 'تعلیمی ادارہ', course: 'کورس', scholarship: 'اسکالرشپ', product: 'مارکیٹ پلیس', donor: 'تعلیمی ڈونر', blog: 'بلاگ', teacher: 'ٹیچر', landing: 'CareerZ' };
const EN_LABEL = { job: 'Job', institute: 'Institute', course: 'Course', scholarship: 'Scholarship', product: 'Marketplace', donor: 'Donor', blog: 'Blog', teacher: 'Teacher', landing: 'CareerZ' };
function urdu(m) {
  const at = m.city ? ` ${m.city} میں` : '';
  switch (m.kind) {
    case 'job': return { title: `${m.city ? `${m.city} میں ` : ''}${m.name} کی نوکری – ${m.org}`, description: `${m.org} میں ${m.name} کی نوکری${m.city ? `، ${m.city}` : ''}۔ ${m.sub ? `${m.sub}۔ ` : ''}CareerZ پر آن لائن اپلائی کریں۔ پاکستان میں تازہ ترین نوکریاں ${year()}۔`, keywords: [`${m.city || 'پاکستان'} میں نوکریاں`, `پاکستان میں نوکریاں ${year()}`, `${m.name} کی نوکری`, 'ٹیچر کی نوکری', 'سرکاری نوکریاں', 'پرائیویٹ نوکریاں'] };
    case 'institute': return { title: `${m.name} – داخلہ ${year()}، فیس اور پروگرامز`, description: `${m.name}${at} کے داخلے ${year()}، فیس اسٹرکچر، پروگرامز اور کورسز۔ CareerZ پر تصدیق شدہ ادارہ، آن لائن داخلہ فارم۔`, keywords: [`${m.name} داخلہ ${year()}`, `${m.name} فیس`, `داخلہ ${year()}`, `${m.city || 'پاکستان'} کے بہترین اسکول`, 'یونیورسٹی داخلہ', 'کالج داخلہ'] };
    case 'course': return { title: `${m.name} کورس${m.free ? ' – مفت' : ''}${m.cert ? ' سرٹیفکیٹ کے ساتھ' : ''}`, description: `${m.name} کورس، ${m.org} کی طرف سے۔ ${m.free ? 'بالکل مفت' : `فیس ${m.price}`}${m.cert ? '، مکمل کرنے پر سرٹیفکیٹ' : ''}۔ پاکستان میں آن لائن کورسز CareerZ پر۔`, keywords: [`${m.name} کورس`, 'آن لائن کورسز', 'مفت آن لائن کورسز سرٹیفکیٹ کے ساتھ', 'آن لائن کلاسز'] };
    case 'scholarship': return { title: `${m.name} اسکالرشپ ${year()}`, description: `${m.name}${m.amount ? `، رقم ${m.amount}` : ''}۔ اہلیت، آخری تاریخ اور اپلائی کرنے کا طریقہ۔ پاکستانی طلبہ کے لیے اسکالرشپس ${year()} CareerZ پر۔`, keywords: [`اسکالرشپ ${year()}`, 'پاکستانی طلبہ کے لیے اسکالرشپ', 'فلی فنڈڈ اسکالرشپ', 'نیڈ بیسڈ اسکالرشپ'] };
    case 'product': return { title: `${m.name} – ${m.price}${m.city ? `، ${m.city}` : ''}`, description: `${m.name} خریدیں، قیمت ${m.price}۔ CareerZ مارکیٹ پلیس پر محفوظ ادائیگی، ڈیلیوری کے بعد ہی بیچنے والے کو رقم ملتی ہے۔`, keywords: ['پرانی کتابیں خریدیں', 'نوٹس برائے فروخت', 'اسکول یونیفارم', 'اسٹوڈنٹ مارکیٹ پلیس'] };
    case 'donor': return { title: `${m.name} – تعلیمی ڈونر اور اسکالرشپس`, description: `${m.name}${at} تعلیم کے لیے فنڈنگ کرنے والا تصدیق شدہ ڈونر۔ ان کی کھلی اسکالرشپس دیکھیں۔`, keywords: ['تعلیمی ڈونر', 'طالب علم کی کفالت', 'تعلیم کے لیے عطیہ'] };
    case 'blog': return { title: m.name, description: `CareerZ بلاگ: ${m.name}۔ اسکالرشپس، داخلوں، نوکریوں اور کیریئر سے متعلق رہنمائی۔`, keywords: ['تعلیمی بلاگ', 'اسکالرشپ گائیڈ', 'کیریئر مشورے'] };
    case 'teacher': return { title: `${m.name} – ${m.subject ? `${m.subject} ٹیچر` : 'ٹیچر'}${m.city ? `، ${m.city}` : ''}`, description: `${m.name}${at} تصدیق شدہ ٹیچر: تجربہ، کورسز اور ریویوز۔ ہوم ٹیوٹر اور آن لائن ٹیوٹر CareerZ پر۔`, keywords: ['ہوم ٹیوٹر', 'آن لائن ٹیوٹر', `${m.city || 'پاکستان'} میں ٹیوٹر`] };
    case 'landing': { const noun = UR_NOUN[m.list] || 'فہرست'; const h = `${m.city || 'پاکستان'} میں ${m.cat ? `${m.cat} ` : ''}${noun} ${year()}`; return { title: h, description: `${h}: CareerZ پر ${m.total} تصدیق شدہ فہرستیں۔ تازہ ترین معلومات اور آن لائن اپلائی۔`, keywords: [h, `${m.city || 'پاکستان'} میں ${noun}`] }; }
    default: return null;
  }
}
const ogUrl = (path, lang) => `${SITE()}/api/seo/og.png?path=${encodeURIComponent(path)}${lang === 'ur' ? '&lang=ur' : ''}`;
function card(page, lang) {
  const m = page.meta || {};
  const ur = lang === 'ur' ? urdu(m) : null;
  const where = m.city ? ` · ${m.city}` : '';
  return { title: ur?.title || page.head.title, sub: m.sub || '', label: lang === 'ur' ? `${UR_LABEL[m.kind] || 'CareerZ'}${m.city ? ` · ${m.city}` : ''}` : `${EN_LABEL[m.kind] || 'CareerZ'}${where}`, lang };
}

// ---------------------------------------------------------------- one page per kind
const EMPLOYMENT = { full_time: 'FULL_TIME', part_time: 'PART_TIME', internship: 'INTERN', freelance: 'CONTRACTOR', government: 'FULL_TIME', ngo: 'FULL_TIME' };
const TYPE_LABEL = { full_time: 'Full-time', part_time: 'Part-time', internship: 'Internship', freelance: 'Freelance', government: 'Government', ngo: 'NGO' };
const money = (cur, n) => (n || n === 0 ? `${cur || 'PKR'} ${Number(n).toLocaleString('en-US')}` : '');

async function jobPage(id) {
  const j = isId(id) && await listings.jobDetail(id);
  if (!j) return null;
  const where = place(j.city, j.country);
  const path = `/jobs/${j._id}`;
  const salary = j.salaryMin || j.salaryMax ? `${money(j.currency, j.salaryMin)}${j.salaryMax ? ` – ${money(j.currency, j.salaryMax)}` : ''}` : '';
  const title = `${j.title} job at ${j.company}${where ? ` in ${where}` : ''}`;
  const description = plain(`${TYPE_LABEL[j.type] || ''} ${j.title} job at ${j.company}${where ? `, ${where}` : ''}.${salary ? ` Salary ${salary}.` : ''}${j.visaSponsorship ? ' Visa sponsorship available.' : ''} ${plain(j.description)}`, 158);
  const jobPosting = {
    '@type': 'JobPosting', title: j.title, description: String(j.description || j.title).slice(0, 8000), datePosted: iso(j.postedAt), validThrough: iso(j.applicationDeadline),
    employmentType: EMPLOYMENT[j.type] || 'FULL_TIME', identifier: { '@type': 'PropertyValue', name: j.company, value: String(j._id) },
    hiringOrganization: { '@type': 'Organization', name: j.company, ...(j.companyLogo ? { logo: j.companyLogo } : {}) },
    directApply: true, url: SITE() + path, industry: j.category || undefined, skills: (j.skills || []).join(', ') || undefined,
    experienceRequirements: j.experienceYears ? { '@type': 'OccupationalExperienceRequirements', monthsOfExperience: j.experienceYears * 12 } : undefined,
    educationRequirements: j.education ? { '@type': 'EducationalOccupationalCredential', credentialCategory: j.education } : undefined,
    totalJobOpenings: j.vacancies || 1
  };
  if (j.workMode === 'remote') { jobPosting.jobLocationType = 'TELECOMMUTE'; jobPosting.applicantLocationRequirements = { '@type': 'Country', name: countryName(j.country) || 'Pakistan' }; }
  else jobPosting.jobLocation = { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: j.city || undefined, addressCountry: String(j.country || 'PK').toUpperCase() } };
  if (j.salaryMin || j.salaryMax) jobPosting.baseSalary = { '@type': 'MonetaryAmount', currency: j.currency || 'PKR', value: { '@type': 'QuantitativeValue', ...(j.salaryMin ? { minValue: j.salaryMin } : {}), ...(j.salaryMax ? { maxValue: j.salaryMax } : {}), unitText: 'MONTH' } };
  const c = [['Home', '/'], ['Jobs', '/jobs'], [j.title, path]];
  const meta = { kind: 'job', name: j.title, org: j.company, city: j.city, sub: salary || TYPE_LABEL[j.type] || '', type: TYPE_LABEL[j.type] || '' };
  return {
    meta,
    head: { title, description, path, image: j.companyLogo, keywords: [`${j.title} jobs`, `${j.title} jobs in ${j.city || 'Pakistan'}`, `jobs in ${j.city || 'Pakistan'}`, `${j.company} jobs`, `jobs in Pakistan ${year()}`, j.category && `${j.category} jobs`, j.visaSponsorship && 'visa sponsorship jobs', j.workMode === 'remote' && 'remote jobs Pakistan', TYPE_LABEL[j.type] && `${TYPE_LABEL[j.type].toLowerCase()} jobs`, ...(j.skills || []).slice(0, 5)].filter(Boolean), schema: graph(jobPosting, crumbs(c)) },
    body: { crumbs: c, h1: j.title, sub: `${j.company}${where ? ` · ${where}` : ''}`, facts: [['Job type', TYPE_LABEL[j.type]], ['Work mode', j.workMode], ['Salary', salary], ['Experience', j.experienceYears ? `${j.experienceYears}+ years` : ''], ['Vacancies', j.vacancies], ['Apply before', j.applicationDeadline ? new Date(j.applicationDeadline).toDateString() : ''], ['Visa sponsorship', j.visaSponsorship ? 'Yes' : '']], paragraphs: [plain(j.description)], lists: [{ title: 'Skills', items: (j.skills || []).map((s) => ({ text: s })) }] }
  };
}

const INST_SCHEMA = { school: 'School', college: 'CollegeOrUniversity', university: 'CollegeOrUniversity', madrasa: 'School', academy: 'EducationalOrganization', tuition_center: 'EducationalOrganization', training_institute: 'EducationalOrganization', online_institute: 'EducationalOrganization' };
async function institutePage(id) {
  const i = isId(id) && await listings.instituteDetail(id);
  if (!i) return null;
  const path = `/institutes/${i._id}`;
  const kind = String(i.type || 'institute').replace('_', ' ');
  const where = place(i.city, i.country);
  const title = `${i.name}${where ? `, ${i.city || countryName(i.country)}` : ''}: admissions ${year()}, programs and fees`;
  const description = plain(`${i.name} is a verified ${kind}${where ? ` in ${where}` : ''}. ${i.programs.length ? `Programs: ${i.programs.slice(0, 4).map((p) => p.name).join(', ')}. ` : ''}See admissions ${year()}, fee structure, courses and jobs on CareerZ. ${plain(i.description)}`, 158);
  const node = {
    '@type': INST_SCHEMA[i.type] || 'EducationalOrganization', name: i.name, description: plain(i.description, 500) || undefined, url: SITE() + path,
    logo: httpsImg(i.logo) || undefined, image: i.coverImage || httpsImg(i.logo) || undefined,
    address: { '@type': 'PostalAddress', streetAddress: i.address || undefined, addressLocality: i.city || undefined, addressCountry: String(i.country || 'PK').toUpperCase() },
    geo: i.location ? { '@type': 'GeoCoordinates', latitude: i.location.lat, longitude: i.location.lng } : undefined,
    sameAs: [i.website, ...Object.values(i.socialLinks || {})].filter((u) => /^https?:\/\//.test(u || '')),
    hasOfferCatalog: i.programs.length ? { '@type': 'OfferCatalog', name: 'Programs', itemListElement: i.programs.map((p) => ({ '@type': 'Offer', itemOffered: { '@type': 'EducationalOccupationalProgram', name: p.name, timeToComplete: p.durationTerms ? `${p.durationTerms} terms` : undefined }, ...(p.tuition ? { price: p.tuition, priceCurrency: p.currency || 'PKR' } : {}) })) } : undefined
  };
  const c = [['Home', '/'], ['Institutes', '/institutes'], [i.name, path]];
  const meta = { kind: 'institute', name: i.name, city: i.city, sub: [kind, where].filter(Boolean).join(' · '), type: i.type };
  return {
    meta,
    head: { title, description, path, image: i.coverImage || httpsImg(i.logo), keywords: [i.name, `${i.name} admissions ${year()}`, `${i.name} fee structure`, `${kind}s in ${i.city || 'Pakistan'}`, `best ${kind} in ${i.city || 'Pakistan'}`, `admissions ${year()}`, ...i.programs.slice(0, 5).map((p) => `${p.name} admission`)], schema: graph(node, crumbs(c)) },
    body: { crumbs: c, h1: i.name, sub: `${kind}${where ? ` · ${where}` : ''} · Verified institute`, paragraphs: [plain(i.description)], facts: [['Address', i.address]], lists: [
      { title: 'Programs', items: i.programs.map((p) => ({ text: [p.name, p.department, p.durationTerms && `${p.durationTerms} terms`, p.tuition && `tuition ${money(p.currency, p.tuition)}`, p.admissionFee && `admission ${money(p.currency, p.admissionFee)}`].filter(Boolean).join(' · ') })) },
      { title: 'Courses', items: i.courses.map((x) => ({ text: x.title, href: `/courses/${x._id}` })) },
      { title: `Jobs at ${i.name}`, items: i.jobs.map((x) => ({ text: x.title, href: `/jobs/${x._id}` })) }
    ] }
  };
}

async function coursePage(id) {
  const c0 = isId(id) && await publicHome.courseDetail(id);
  if (!c0) return null;
  const path = `/courses/${c0._id}`;
  const by = c0.institution?.name || c0.teacher?.name || 'CareerZ';
  const free = c0.isFree || !c0.price;
  const title = `${c0.title}${c0.level ? ` (${c0.level})` : ''} course${free ? ' – free' : ''}${c0.certificate ? ' with certificate' : ''}`;
  const description = plain(`${c0.title} by ${by}. ${free ? 'Free' : `Fee ${money(c0.currency, c0.price)}`}${c0.certificate ? ', certificate on completion' : ''}. ${plain(c0.description)}`, 158);
  const mode = { online: 'Online', physical: 'Onsite', hybrid: 'Blended', recorded: 'Online', self_paced: 'Online' }[c0.studyMode] || 'Online';
  const node = {
    '@type': 'Course', name: c0.title, description: plain(c0.description, 500) || c0.title, url: SITE() + path, inLanguage: c0.language || 'en',
    provider: { '@type': c0.institution ? 'EducationalOrganization' : 'Person', name: by },
    offers: { '@type': 'Offer', category: free ? 'Free' : 'Paid', price: free ? 0 : c0.price, priceCurrency: c0.currency || 'PKR', availability: 'https://schema.org/InStock', url: SITE() + path },
    hasCourseInstance: { '@type': 'CourseInstance', courseMode: mode, courseWorkload: c0.creditHours ? `PT${c0.creditHours}H` : 'PT10H' },
    educationalLevel: c0.level || undefined, keywords: (c0.tags || []).join(', ') || undefined
  };
  const cr = [['Home', '/'], ['Courses', '/courses'], [c0.title, path]];
  const meta = { kind: 'course', name: c0.title, org: by, free, cert: c0.certificate, sub: free ? 'Free course' : money(c0.currency, c0.price), price: money(c0.currency, c0.price) };
  return {
    meta,
    head: { title, description, path, image: c0.image, keywords: [`${c0.title} course`, `${c0.title} online`, free ? 'free online courses with certificate' : 'online courses Pakistan', c0.subject && `${c0.subject} course`, c0.level && `${c0.level} ${c0.subject || ''}`.trim(), `${by} courses`, ...(c0.tags || []).slice(0, 5)].filter(Boolean), schema: graph(node, crumbs(cr)) },
    body: { crumbs: cr, h1: c0.title, sub: [c0.subject, c0.level, `by ${by}`].filter(Boolean).join(' · '), facts: [['Fee', free ? 'Free' : money(c0.currency, c0.price)], ['Certificate', c0.certificate ? 'Yes' : ''], ['Language', c0.language]], paragraphs: [plain(c0.description)] }
  };
}

async function scholarshipPage(id) {
  const s = isId(id) && await listings.scholarshipDetail(id);
  if (!s) return null;
  const path = `/scholarships/${s._id}`;
  const where = countryName(s.country);
  const title = `${s.title}${s.amount ? ` – ${money(s.currency, s.amount)}` : ''} scholarship ${year()}`;
  const description = plain(`${s.title}${where ? ` (${where})` : ''}${s.amount ? `, worth ${money(s.currency, s.amount)}` : ''}${s.applicationDeadline ? `. Apply before ${new Date(s.applicationDeadline).toDateString()}` : ''}. Eligibility: ${plain(s.eligibility, 90)} ${plain(s.description)}`, 158);
  const node = { '@type': 'MonetaryGrant', name: s.title, description: plain(s.description, 500) || s.title, url: SITE() + path, amount: s.amount ? { '@type': 'MonetaryAmount', value: s.amount, currency: s.currency || 'PKR' } : undefined, funder: { '@type': 'Organization', name: s.provider?.name || 'Verified donor' } };
  const c = [['Home', '/'], ['Scholarships', '/scholarships'], [s.title, path]];
  const meta = { kind: 'scholarship', name: s.title, org: s.provider?.name, amount: money(s.currency, s.amount), sub: [money(s.currency, s.amount), s.applicationDeadline && `Apply by ${new Date(s.applicationDeadline).toDateString()}`].filter(Boolean).join(' · ') };
  return {
    meta,
    head: { title, description, path, keywords: [s.title, `scholarships in Pakistan ${year()}`, 'scholarships for Pakistani students', 'need based scholarship', where && `scholarships in ${where}`, 'fully funded scholarships', 'how to apply scholarship'].filter(Boolean), schema: graph(node, crumbs(c)) },
    body: { crumbs: c, h1: s.title, sub: `By ${s.provider?.name || 'Verified donor'}`, facts: [['Amount', money(s.currency, s.amount)], ['Seats', s.seatsAvailable], ['Deadline', s.applicationDeadline ? new Date(s.applicationDeadline).toDateString() : ''], ['Country', where]], paragraphs: [plain(s.description), s.eligibility && `Eligibility: ${plain(s.eligibility)}`] }
  };
}

async function productPage(id) {
  const p = isId(id) && await listings.productDetail(id);
  if (!p) return null;
  const path = `/marketplace/${p._id}`;
  const [rating] = await require('../models/Review').aggregate([{ $match: { product: new mongoose.Types.ObjectId(String(p._id)), hidden: { $ne: true } } }, { $group: { _id: null, avg: { $avg: '$rating' }, n: { $sum: 1 } } }]);
  const images = (p.images || []).filter((u) => /^https:\/\//.test(u));
  const title = `${p.title} – ${money(p.currency, p.price)}${p.seller?.city ? ` in ${p.seller.city}` : ''}`;
  const description = plain(`Buy ${p.title} for ${money(p.currency, p.price)} on CareerZ Marketplace${p.seller?.city ? `, ${p.seller.city}` : ''}. Safe payment held until delivery. ${plain(p.description)}`, 158);
  const node = {
    '@type': 'Product', name: p.title, description: plain(p.description, 500) || p.title, image: images.length ? images : [LOGO()], category: p.category, url: SITE() + path, sku: String(p._id),
    brand: { '@type': 'Brand', name: p.seller?.name || 'CareerZ seller' },
    offers: { '@type': 'Offer', price: p.price, priceCurrency: p.currency || 'PKR', availability: p.digital || p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', itemCondition: 'https://schema.org/UsedCondition', url: SITE() + path, seller: { '@type': 'Person', name: p.seller?.name || 'CareerZ seller' } },
    ...(rating?.n ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: Number(rating.avg.toFixed(1)), reviewCount: rating.n } } : {})
  };
  if (!p.digital) delete node.offers.itemCondition;
  const c = [['Home', '/'], ['Marketplace', '/marketplace'], [p.title, path]];
  const meta = { kind: 'product', name: p.title, city: p.seller?.city, price: money(p.currency, p.price), sub: [money(p.currency, p.price), p.category].filter(Boolean).join(' · ') };
  return {
    meta,
    head: { title, description, path, image: images[0], type: 'product', keywords: [p.title, `buy ${p.title}`, `${p.category} for sale Pakistan`, p.seller?.city && `${p.category} in ${p.seller.city}`, 'buy sell books Pakistan', 'student marketplace Pakistan'].filter(Boolean), schema: graph(node, crumbs(c)) },
    body: { crumbs: c, h1: p.title, sub: `${p.category}${p.seller ? ` · sold by ${p.seller.name}` : ''}`, facts: [['Price', money(p.currency, p.price)], ['Rating', rating?.n ? `${rating.avg.toFixed(1)} / 5 (${rating.n} reviews)` : '']], paragraphs: [plain(p.description)] }
  };
}

async function donorPage(id) {
  const d = isId(id) && await listings.donorDetail(id);
  if (!d) return null;
  const path = `/donors/${d._id}`;
  const description = plain(`${d.name} is a verified ${d.type.toLowerCase()} on CareerZ${place(d.city, d.country) ? ` in ${place(d.city, d.country)}` : ''}, funding education${d.focusAreas.length ? ` in ${d.focusAreas.join(', ')}` : ''}. ${plain(d.about)}`, 158);
  const node = { '@type': d.type === 'Organization' ? 'Organization' : 'Person', name: d.name, description: plain(d.about, 400) || undefined, url: SITE() + path, ...(d.logo && /^https:/.test(d.logo) ? { image: d.logo } : {}) };
  const c = [['Home', '/'], ['Donors', '/donors'], [d.name, path]];
  const meta = { kind: 'donor', name: d.name, city: d.city, sub: d.type };
  return {
    meta,
    head: { title: `${d.name} – education donor and scholarships`, description, path, keywords: [d.name, 'education donors Pakistan', 'scholarship sponsors', 'donate for education Pakistan', ...d.focusAreas], schema: graph(node, crumbs(c)) },
    body: { crumbs: c, h1: d.name, sub: `${d.type} · Verified donor`, paragraphs: [plain(d.about)], lists: [{ title: 'Open scholarships', items: d.scholarships.map((s) => ({ text: s.title, href: `/scholarships/${s._id}` })) }] }
  };
}

async function blogPage(slug) {
  if (!/^[a-z0-9-]{1,120}$/i.test(slug)) return null;
  const post = await require('../models/BlogPost').findOne({ slug: slug.toLowerCase(), status: 'published' }).populate('author', 'fullName').lean();
  if (!post) return null;
  const path = `/blog/${post.slug}`;
  const image = /^https:\/\//.test(post.coverImage || '') ? post.coverImage : post.coverImage ? `${SITE()}/api/blog/cover/${post.slug}` : null;
  const description = plain(post.excerpt || post.content, 158);
  const words = plain(post.content).split(' ').length;
  const node = {
    '@type': 'BlogPosting', headline: post.title.slice(0, 110), description, image: image ? [image] : [LOGO()], datePublished: iso(post.publishedAt || post.createdAt), dateModified: iso(post.updatedAt),
    author: { '@type': 'Person', name: post.author?.fullName || 'CareerZ' }, publisher: { ...org }, mainEntityOfPage: SITE() + path, articleSection: post.category || undefined, wordCount: words, inLanguage: 'en'
  };
  const c = [['Home', '/'], ['Blog', '/blog'], [post.title, path]];
  const meta = { kind: 'blog', name: post.title, sub: [post.category, post.author?.fullName && `By ${post.author.fullName}`].filter(Boolean).join(' · '), image };
  return {
    meta,
    head: { title: post.title, description, path, image, type: 'article', keywords: [post.title, post.category, 'education blog Pakistan', 'career tips', 'study tips'].filter(Boolean), schema: graph(node, crumbs(c)),
      extra: `<meta property="article:published_time" content="${iso(post.publishedAt || post.createdAt)}"/>${post.category ? `<meta property="article:section" content="${esc(post.category)}"/>` : ''}<link rel="alternate" type="application/rss+xml" title="CareerZ Blog" href="${SITE()}/rss.xml"/>` },
    body: { crumbs: c, h1: post.title, sub: [post.category, post.author?.fullName && `By ${post.author.fullName}`, (post.publishedAt || post.createdAt) && new Date(post.publishedAt || post.createdAt).toDateString()].filter(Boolean).join(' · '), paragraphs: String(post.content || '').replace(/<\/(p|h[1-6]|li|div)>/gi, '\n\n').split(/\n\n+/).map((x) => plain(x)).filter(Boolean).slice(0, 60) }
  };
}

async function teacherPage(id) {
  if (!isId(id)) return null;
  const prof = await require('../models/TeacherProfile').findOne({ user: id, publicPortfolio: true, status: 'active' }).populate('user', 'fullName city country').lean();
  if (!prof?.user) return null;
  const path = `/teacher/${id}`;
  const name = prof.user.fullName;
  const subjects = [...(prof.subjects || []), ...(prof.categories || []).map((c) => String(c).replace(/_/g, ' '))].slice(0, 6);
  const about = plain(prof.bio || prof.about || prof.introduction || '');
  const description = plain(`${name}, ${subjects.slice(0, 3).join(', ') || 'teacher'}${prof.user.city ? ` in ${prof.user.city}` : ''}. Verified teacher portfolio on CareerZ: experience, courses and reviews. ${about}`, 158);
  const node = { '@type': 'Person', name, jobTitle: subjects[0] ? `${subjects[0]} teacher` : 'Teacher', knowsAbout: subjects, url: SITE() + path, address: prof.user.city ? { '@type': 'PostalAddress', addressLocality: prof.user.city, addressCountry: String(prof.user.country || 'PK').toUpperCase() } : undefined };
  const c = [['Home', '/'], ['Teachers', '/courses'], [name, path]];
  const meta = { kind: 'teacher', name, city: prof.user.city, subject: subjects[0], sub: subjects.slice(0, 3).join(' · ') };
  return {
    meta,
    head: { title: `${name} – ${subjects[0] || 'Teacher'}${prof.user.city ? ` in ${prof.user.city}` : ''}`, description, path, type: 'profile', keywords: [name, ...subjects.map((s) => `${s} teacher`), prof.user.city && `tutor in ${prof.user.city}`, 'home tutor', 'online tutor Pakistan'].filter(Boolean), schema: graph(node, crumbs(c)) },
    body: { crumbs: c, h1: name, sub: subjects.join(' · '), paragraphs: [about] }
  };
}

async function instituteSitePage(sub, page) {
  if (!/^[a-z0-9-]{1,63}$/i.test(sub)) return null;
  const s = await require('../models/InstitutionSettings').findOne({ subdomain: sub.toLowerCase() }).select('institution').lean();
  if (!s) return null;
  const r = await institutePage(String(s.institution));
  if (!r) return null;
  const path = `/i/${sub.toLowerCase()}${page ? `/${page}` : ''}`;
  r.head.path = path;
  r.head.title = page ? `${String(page).replace(/-/g, ' ')} – ${r.body.h1}` : `${r.body.h1} – official website`;
  return r;
}

// City / category landing pages: /jobs?city=Lahore, /institutes?city=Karachi&type=school, …
const LANDING = {
  jobs: { noun: 'Jobs', list: (q) => listings.listJobs(q), item: (x) => ({ text: `${x.title} – ${x.company}${x.city ? `, ${x.city}` : ''}`, href: `/jobs/${x._id}` }) },
  institutes: { noun: 'Schools, colleges & universities', list: (q) => listings.listInstitutes(q), item: (x) => ({ text: `${x.name}${x.city ? `, ${x.city}` : ''}`, href: `/institutes/${x._id}` }) },
  courses: { noun: 'Courses', list: (q) => publicHome.listCourses(q), item: (x) => ({ text: x.title, href: `/courses/${x._id}` }) },
  scholarships: { noun: 'Scholarships', list: (q) => listings.listScholarships(q), item: (x) => ({ text: x.title, href: `/scholarships/${x._id}` }) },
  marketplace: { noun: 'Books, notes & uniforms for sale', list: (q) => listings.listProducts(q), item: (x) => ({ text: x.title, href: `/marketplace/${x._id}` }) }
};
async function landingPage(kind, query) {
  const L = LANDING[kind];
  const keys = Object.keys(query).filter((k) => ['city', 'category', 'type'].includes(k) && /^[\w .&-]{1,60}$/.test(query[k]));
  if (!L || !keys.length) return null;
  const pick = Object.fromEntries(keys.sort().map((k) => [k, String(query[k])]));
  const r = await L.list({ ...pick, limit: 30 });
  const cat = (pick.category || pick.type || '').replace(/_/g, ' ');
  const where = pick.city || 'Pakistan';
  const h1 = `${cat ? `${cat.charAt(0).toUpperCase()}${cat.slice(1)} ${L.noun.toLowerCase()}` : L.noun} in ${where} ${year()}`;
  const path = `/${kind}?${new URLSearchParams(pick).toString()}`;
  const items = r.items.map(L.item);
  const c = [['Home', '/'], [L.noun, `/${kind}`], [h1, path]];
  const meta = { kind: 'landing', list: kind, city: pick.city, cat, total: r.total, name: h1, sub: `${r.total} listing${r.total === 1 ? '' : 's'}` };
  return {
    meta,
    head: { title: h1, description: plain(`${h1}: ${r.total} verified listing${r.total === 1 ? '' : 's'} on CareerZ. ${items.slice(0, 4).map((x) => x.text).join('; ')}.`, 158), path, noindex: !r.total,
      keywords: [h1, `${L.noun.toLowerCase()} in ${where}`, `${kind} ${where}`, cat && `${cat} ${kind} ${where}`, `latest ${kind} ${where}`].filter(Boolean),
      schema: graph({ '@type': 'CollectionPage', name: h1, url: SITE() + path, mainEntity: { '@type': 'ItemList', numberOfItems: r.total, itemListElement: items.map((x, i) => ({ '@type': 'ListItem', position: i + 1, url: SITE() + x.href, name: x.text })) } }, crumbs(c)) },
    body: { crumbs: c, h1, sub: `${r.total} listing${r.total === 1 ? '' : 's'}`, lists: [{ title: h1, items }] }
  };
}

const ROUTES = [
  [/^\/jobs\/([^/]+)$/, (m) => jobPage(m[1])],
  [/^\/institutes\/([^/]+)$/, (m) => institutePage(m[1])],
  [/^\/courses\/([^/]+)$/, (m) => coursePage(m[1])],
  [/^\/scholarships\/([^/]+)$/, (m) => scholarshipPage(m[1])],
  [/^\/marketplace\/([^/]+)$/, (m) => productPage(m[1])],
  [/^\/donors\/([^/]+)$/, (m) => donorPage(m[1])],
  [/^\/blog\/([^/]+)$/, (m) => blogPage(m[1])],
  [/^\/teacher\/([^/]+)$/, (m) => teacherPage(m[1])],
  [/^\/i\/([^/]+)(?:\/([^/]+))?$/, (m) => instituteSitePage(m[1], m[2])]
];

// The page for a path: { status, html }. A missing item gets the shell with noindex and a 404.
// The page object for a path (shared by render and the share card).
async function pageFor(path, query = {}) {
  const kind = path.match(/^\/(jobs|institutes|courses|scholarships|marketplace)$/)?.[1];
  if (kind) return landingPage(kind, query).catch(() => null);
  for (const [re, fn] of ROUTES) { const m = path.match(re); if (m) return fn(m).catch(() => null); }
  return null;
}
const splitLang = (raw) => { const p = String(raw || '/').split('?')[0].replace(/\/+$/, '') || '/'; const ur = /^\/ur(\/|$)/.test(p); return { lang: ur ? 'ur' : 'en', path: ur ? p.slice(3) || '/' : p }; };

async function render(rawPath, query = {}) {
  const html = await template();
  if (!html) return { status: 503, html: '' };
  const { lang, path } = splitLang(rawPath);
  const page = await pageFor(path, query);
  if (page) {
    const own = page.meta?.kind === 'product' ? page.head.image : page.meta?.image;
    page.head.image = own || ogUrl((lang === 'ur' ? '/ur' : '') + path + (page.meta?.kind === 'landing' ? `?${new URLSearchParams(query).toString()}` : ''), lang);
    page.head.lang = lang;
    const ur = lang === 'ur' && urdu(page.meta || {});
    if (ur) { page.head.title = ur.title; page.head.description = ur.description; page.head.keywords = [...ur.keywords, ...page.head.keywords]; page.body.h1 = ur.title; }
  }
  const head = page ? headTags(page.head) : headTags({ title: 'Page not found', description: 'This page is no longer available on CareerZ. Explore jobs, scholarships, institutes and courses.', path, noindex: true });
  const rawBody = page ? bodyHtml(page.body) : bodyHtml({ crumbs: [['Home', '/']], h1: 'Page not found', paragraphs: ['This listing has closed or was removed.'] });
  // Links inside an Urdu page stay in Urdu.
  const body = lang === 'ur' ? rawBody.replace(/href="\/(?!ur\/|api\/)/g, 'href="/ur/') : rawBody;
  const shellHtml = lang === 'ur' ? html.replace(/<html[^>]*>/, '<html lang="ur" dir="rtl">') : html;
  const out = shellHtml.replace(/<!--seo:head-->[\s\S]*?<!--\/seo:head-->/, `<!--seo:head-->${head}<!--/seo:head-->`).replace(/<!--seo:body-->[\s\S]*?<!--\/seo:body-->/, `<!--seo:body-->${body}<!--/seo:body-->`);
  return { status: page ? 200 : 404, html: out };
}

// ---------------------------------------------------------------- sitemap and RSS
const STATIC_PATHS = [['/', 'daily', 1.0], ['/jobs', 'hourly', 0.9], ['/scholarships', 'daily', 0.9], ['/institutes', 'daily', 0.9], ['/courses', 'daily', 0.9], ['/marketplace', 'daily', 0.8], ['/donors', 'weekly', 0.6], ['/visa', 'weekly', 0.7], ['/blog', 'daily', 0.8],
  ...['about', 'contact', 'faq', 'help', 'careers', 'partnership', 'advertise', 'press', 'agent-program', 'donor-program', 'become-a-seller', 'news'].map((s) => [`/${s}`, 'monthly', 0.5]),
  ...['privacy', 'terms', 'cookies', 'refund', 'cancellation', 'community-guidelines', 'code-of-conduct', 'accessibility', 'sitemap'].map((s) => [`/${s}`, 'yearly', 0.3])];
async function sitemap() {
  const base = SITE();
  // Each page is listed in English and Urdu, each pointing at the other (hreflang).
  const alts = (loc) => { const ur = `/ur${loc === '/' ? '' : loc}`; return `<xhtml:link rel="alternate" hreflang="en" href="${esc(base + loc)}"/><xhtml:link rel="alternate" hreflang="ur" href="${esc(base + ur)}"/><xhtml:link rel="alternate" hreflang="x-default" href="${esc(base + loc)}"/>`; };
  const one = (loc, lastmod, freq, pri, image) => `<url><loc>${esc(base + loc)}</loc>${alts(loc.replace(/^\/ur(?=\/|$)/, '') || '/')}${lastmod ? `<lastmod>${iso(lastmod).slice(0, 10)}</lastmod>` : ''}${freq ? `<changefreq>${freq}</changefreq>` : ''}${pri != null ? `<priority>${pri.toFixed(1)}</priority>` : ''}${image ? `<image:image><image:loc>${esc(image)}</image:loc></image:image>` : ''}</url>`;
  const url = (loc, lastmod, freq, pri, image) => one(loc, lastmod, freq, pri, image) + one(`/ur${loc === '/' ? '' : loc}`, lastmod, freq, pri != null ? Math.max(0.1, pri - 0.1) : pri, image);
  const rows = STATIC_PATHS.map(([p, f, pr]) => url(p, null, f, pr));
  const take = async (fn) => { try { return await fn(); } catch { return []; } };
  // Every page of a listing (the public lists are paged), up to 200 pages.
  const all = async (list) => { const out = []; for (let page = 1; page <= 200; page += 1) { const r = await list({ limit: 48, page }); out.push(...r.items); if (page >= r.pages) break; } return out; };
  const [jobs, sch, inst, prod, donors, courses] = await Promise.all([
    take(() => all(listings.listJobs)), take(() => all(listings.listScholarships)), take(() => all(listings.listInstitutes)),
    take(() => all(listings.listProducts)), take(() => all(listings.listDonors)), take(() => all(publicHome.listCourses))
  ]);
  const cities = (list) => [...new Set(list.map((x) => x.city).filter((c) => /^[\w .-]{2,40}$/.test(c || '')))];
  cities(jobs).forEach((c) => rows.push(url(`/jobs?city=${encodeURIComponent(c)}`, null, 'daily', 0.8)));
  cities(inst).forEach((c) => rows.push(url(`/institutes?city=${encodeURIComponent(c)}`, null, 'weekly', 0.8)));
  jobs.forEach((j) => rows.push(url(`/jobs/${j._id}`, j.postedAt, 'daily', j.featured ? 0.9 : 0.8)));
  sch.forEach((s) => rows.push(url(`/scholarships/${s._id}`, s.postedAt, 'weekly', 0.8)));
  inst.forEach((i) => rows.push(url(`/institutes/${i._id}`, null, 'weekly', 0.8, httpsImg(i.logo))));
  courses.forEach((c) => rows.push(url(`/courses/${c._id}`, c.postedAt, 'weekly', 0.7, c.image)));
  prod.forEach((p) => rows.push(url(`/marketplace/${p._id}`, p.postedAt, 'weekly', 0.6, httpsImg(p.image))));
  donors.forEach((d) => rows.push(url(`/donors/${d._id}`, null, 'monthly', 0.5)));
  const posts = await take(() => require('../models/BlogPost').find({ status: 'published' }).select('slug updatedAt coverImage').sort({ publishedAt: -1 }).limit(5000).lean());
  posts.forEach((p) => rows.push(url(`/blog/${p.slug}`, p.updatedAt, 'monthly', 0.7, httpsImg(p.coverImage))));
  const teachers = await take(() => require('../models/TeacherProfile').find({ publicPortfolio: true, status: 'active' }).select('user updatedAt').limit(5000).lean());
  teachers.forEach((t) => rows.push(url(`/teacher/${t.user}`, t.updatedAt, 'monthly', 0.5)));
  const sites = await take(() => require('../models/InstitutionSettings').find({ subdomain: { $nin: [null, ''] } }).select('subdomain updatedAt').limit(5000).lean());
  sites.forEach((s) => rows.push(url(`/i/${s.subdomain}`, s.updatedAt, 'weekly', 0.6)));
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">${rows.join('')}</urlset>`;
}

async function rss() {
  const base = SITE();
  const posts = await require('../models/BlogPost').find({ status: 'published' }).populate('author', 'fullName').sort({ publishedAt: -1 }).limit(50).lean();
  const items = posts.map((p) => `<item><title>${esc(p.title)}</title><link>${base}/blog/${esc(p.slug)}</link><guid isPermaLink="true">${base}/blog/${esc(p.slug)}</guid><pubDate>${new Date(p.publishedAt || p.createdAt).toUTCString()}</pubDate>${p.category ? `<category>${esc(p.category)}</category>` : ''}<dc:creator>${esc(p.author?.fullName || 'CareerZ')}</dc:creator><description>${esc(plain(p.excerpt || p.content, 300))}</description></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>CareerZ Blog – education, scholarships and career guides</title><link>${base}/blog</link><atom:link href="${base}/rss.xml" rel="self" type="application/rss+xml"/><description>Study tips, scholarship guides, admissions and career advice for students, parents and teachers in Pakistan.</description><language>en-pk</language>${posts[0] ? `<lastBuildDate>${new Date(posts[0].publishedAt || posts[0].createdAt).toUTCString()}</lastBuildDate>` : ''}${items}</channel></rss>`;
}

// The share card PNG for a page (cached; the text always comes from CareerZ's own data, never the URL).
const cards = new Map();
async function ogImage(rawPath, lang) {
  const { path } = splitLang(rawPath);
  const [p, qs] = String(path).split('?');
  const key = `${lang}:${rawPath}`;
  const hit = cards.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600000) return hit.png;
  const page = await pageFor(p, Object.fromEntries(new URLSearchParams(qs || '')));
  const c = page ? card(page, lang) : { title: lang === 'ur' ? 'پاکستان میں نوکریاں، اسکالرشپس، داخلے اور کورسز' : 'Jobs, scholarships, admissions and courses in Pakistan', sub: 'careerz.pk', label: 'CareerZ', lang };
  const png = require('../utils/ogCard').png(c);
  if (cards.size > 500) cards.delete(cards.keys().next().value);
  cards.set(key, { at: Date.now(), png });
  return png;
}

module.exports = { render, sitemap, rss, template, headTags, ogImage, urdu };
