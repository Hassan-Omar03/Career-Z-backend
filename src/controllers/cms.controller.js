const Page = require('../models/Page');
const BlogPost = require('../models/BlogPost');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/apiResponse');

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ---------------------------------------------------------------------------------- Pages

// GET /api/pages (public) — only published pages, for a public listing/nav.
const listPublishedPages = asyncHandler(async (req, res) => {
  const pages = await Page.find({ status: 'published' }).select('slug title seoTitle updatedAt').sort({ title: 1 });
  return ok(res, pages);
});

// GET /api/pages/:slug (public) — 404s a draft the same as a nonexistent slug, so drafts never leak.
const getPublishedPage = asyncHandler(async (req, res) => {
  const page = await Page.findOne({ slug: req.params.slug, status: 'published' });
  if (!page) throw new AppError('Page not found.', 404);
  return ok(res, page);
});

// GET /api/pages/admin/all (Super Admin) — every page regardless of status.
const adminListPages = asyncHandler(async (req, res) => {
  const pages = await Page.find().populate('updatedBy', 'fullName').sort({ updatedAt: -1 });
  return ok(res, pages);
});

// POST /api/pages (Super Admin)
const createPage = asyncHandler(async (req, res) => {
  const { title, slug, content, status, seoTitle, seoDescription } = req.body;
  if (!title) throw new AppError('title is required.', 422);
  const finalSlug = slugify(slug || title);
  const existing = await Page.findOne({ slug: finalSlug });
  if (existing) throw new AppError('A page with that slug already exists.', 409);

  const page = await Page.create({
    title, slug: finalSlug, content: content || '', status: status || 'draft',
    seoTitle: seoTitle || '', seoDescription: seoDescription || '', updatedBy: req.user._id
  });
  return created(res, page, 'Page created.');
});

// PATCH /api/pages/:id (Super Admin)
const updatePage = asyncHandler(async (req, res) => {
  const page = await Page.findById(req.params.id);
  if (!page) throw new AppError('Page not found.', 404);

  const allowed = ['title', 'content', 'status', 'seoTitle', 'seoDescription'];
  allowed.forEach((f) => { if (req.body[f] !== undefined) page[f] = req.body[f]; });
  page.updatedBy = req.user._id;
  await page.save();
  return ok(res, page, 'Page saved.');
});

// DELETE /api/pages/:id (Super Admin)
const deletePage = asyncHandler(async (req, res) => {
  const page = await Page.findById(req.params.id);
  if (!page) throw new AppError('Page not found.', 404);
  await page.deleteOne();
  return ok(res, null, 'Page deleted.');
});

// ------------------------------------------------------------------------------- Blog posts

// GET /api/blog (public)
// A blog cover is an https link or an uploaded image (kept on the post, served by /blog/cover/:slug).
const COVER_DATA = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;
function checkCover(v) {
  if (v === undefined || v === '' || v === null) return v === null ? '' : v;
  const s = String(v);
  if (/^https:\/\//.test(s)) return s.slice(0, 1000);
  if (!COVER_DATA.test(s)) throw new AppError('The cover must be a PNG, JPG or WEBP image, or an https link.', 422);
  if (s.length > 900000) throw new AppError('The cover image is too large. Use one under about 600 KB.', 422);
  return s;
}
// What readers get: the cover as a URL path, never the raw image data in lists.
function publicCover(post) { const c = post.coverImage || ''; return /^https:\/\//.test(c) ? c : c ? `/blog/cover/${post.slug}?v=${new Date(post.updatedAt || 0).getTime()}` : ''; }
function publicPost(p, withContent) {
  const o = p.toObject ? p.toObject() : { ...p };
  o.coverUrl = publicCover(o);
  delete o.coverImage;
  if (!withContent) delete o.content;
  o.readMinutes = Math.max(1, Math.round(String(p.content || '').split(/\s+/).length / 200));
  return o;
}

// A blog change shows on the home page at once (its section is cached for a minute).
const freshHome = () => { try { require('../services/publicHome.service').resetCache(); } catch { /* home not loaded */ } };

const listPublishedPosts = asyncHandler(async (req, res) => {
  const filter = { status: 'published' };
  if (req.query.category) filter.category = req.query.category;
  const posts = await BlogPost.find(filter).populate('author', 'fullName').sort({ publishedAt: -1 }).limit(50);
  return ok(res, posts.map((p) => publicPost(p, false)));
});

// GET /api/blog/cover/:slug — the uploaded cover image of a published post.
const postCover = asyncHandler(async (req, res) => {
  const post = await BlogPost.findOne({ slug: req.params.slug, status: 'published' }).select('coverImage').lean();
  const m = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/.exec(post?.coverImage || '');
  if (!m) throw new AppError('Cover not found.', 404);
  res.setHeader('Content-Type', m[1]);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.send(Buffer.from(m[2], 'base64'));
});

// GET /api/blog/:slug (public)
const getPublishedPost = asyncHandler(async (req, res) => {
  const post = await BlogPost.findOne({ slug: req.params.slug, status: 'published' }).populate('author', 'fullName');
  if (!post) throw new AppError('Post not found.', 404);
  return ok(res, publicPost(post, true));
});

// GET /api/blog/admin/all (Super Admin)
const adminListPosts = asyncHandler(async (req, res) => {
  const posts = await BlogPost.find().populate('author', 'fullName').sort({ createdAt: -1 });
  return ok(res, posts);
});

// POST /api/blog (Super Admin)
const createPost = asyncHandler(async (req, res) => {
  const { title, slug, excerpt, content, category, status, coverImage } = req.body;
  if (!title) throw new AppError('title is required.', 422);
  const finalSlug = slugify(slug || title);
  const existing = await BlogPost.findOne({ slug: finalSlug });
  if (existing) throw new AppError('A post with that slug already exists.', 409);

  const publishNow = status === 'published';
  const post = await BlogPost.create({
    title, slug: finalSlug, excerpt: excerpt || '', content: content || '', category: category || '',
    status: status || 'draft', coverImage: checkCover(coverImage) || '', author: req.user._id,
    publishedAt: publishNow ? new Date() : null
  });
  freshHome();
  return created(res, post, 'Post created.');
});

// PATCH /api/blog/:id (Super Admin)
const updatePost = asyncHandler(async (req, res) => {
  const post = await BlogPost.findById(req.params.id);
  if (!post) throw new AppError('Post not found.', 404);

  const wasPublished = post.status === 'published';
  const allowed = ['title', 'excerpt', 'content', 'category', 'status', 'coverImage'];
  if (req.body.coverImage !== undefined) req.body.coverImage = checkCover(req.body.coverImage);
  if (req.body.status !== undefined && !['draft', 'published'].includes(req.body.status)) throw new AppError('Status must be draft or published.', 422);
  allowed.forEach((f) => { if (req.body[f] !== undefined) post[f] = req.body[f]; });
  if (!wasPublished && post.status === 'published' && !post.publishedAt) post.publishedAt = new Date();
  await post.save();
  freshHome();
  return ok(res, post, 'Post saved.');
});

// DELETE /api/blog/:id (Super Admin)
const deletePost = asyncHandler(async (req, res) => {
  const post = await BlogPost.findById(req.params.id);
  if (!post) throw new AppError('Post not found.', 404);
  await post.deleteOne();
  freshHome();
  return ok(res, null, 'Post deleted.');
});

module.exports = {
  postCover,
  listPublishedPages, getPublishedPage, adminListPages, createPage, updatePage, deletePage,
  listPublishedPosts, getPublishedPost, adminListPosts, createPost, updatePost, deletePost
};
