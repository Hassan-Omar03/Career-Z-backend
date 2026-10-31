const router = require('express').Router();
const wrap = require('../utils/asyncHandler');
const seo = require('../services/seo.service');

// Dynamic SEO for search engines and social previews (nginx proxies the public pages here).
router.get('/render', wrap(async (req, res) => {
  const { status, html } = await seo.render(String(req.query.path || '/'), (({ path, ...rest }) => rest)(req.query));
  if (!html) return res.status(503).send('');
  res.set('Cache-Control', 'public, max-age=300');
  return res.status(status).type('html').send(html);
}));
// Share card for a page (WhatsApp/Facebook/LinkedIn preview). Rate-limited by the cache in seo.service.
router.get('/og.png', wrap(async (req, res) => { const png = await seo.ogImage(String(req.query.path || '/').slice(0, 300), req.query.lang === 'ur' ? 'ur' : 'en'); res.set('Cache-Control', 'public, max-age=86400'); return res.type('png').send(png); }));
// IndexNow (Bing, Yandex…): status and a manual 'send every page now' for admins.
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const indexNow = require('../services/indexNow.service');
router.get('/indexnow', protect, requireRole('admin', 'super_admin'), wrap(async (req, res) => require('../utils/apiResponse').ok(res, await indexNow.status())));
router.post('/indexnow/submit', protect, requireRole('admin', 'super_admin'), wrap(async (req, res) => require('../utils/apiResponse').ok(res, await indexNow.run({ all: true }))));
router.get('/sitemap.xml', wrap(async (req, res) => { res.set('Cache-Control', 'public, max-age=1800'); return res.type('application/xml').send(await seo.sitemap()); }));
router.get('/rss.xml', wrap(async (req, res) => { res.set('Cache-Control', 'public, max-age=1800'); return res.type('application/rss+xml').send(await seo.rss()); }));

module.exports = router;
