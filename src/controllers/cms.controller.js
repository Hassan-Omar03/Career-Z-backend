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
const listPublishedPosts = asyncHandler(async (req, res) => {
  const filter = { status: 'published' };
  if (req.query.category) filter.category = req.query.category;
  const posts = await BlogPost.find(filter).populate('author', 'fullName').select('-content').sort({ publishedAt: -1 }).limit(50);
  return ok(res, posts);
});

// GET /api/blog/:slug (public)
const getPublishedPost = asyncHandler(async (req, res) => {
  const post = await BlogPost.findOne({ slug: req.params.slug, status: 'published' }).populate('author', 'fullName');
  if (!post) throw new AppError('Post not found.', 404);
  return ok(res, post);
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
    status: status || 'draft', coverImage: coverImage || '', author: req.user._id,
    publishedAt: publishNow ? new Date() : null
  });
  return created(res, post, 'Post created.');
});

// PATCH /api/blog/:id (Super Admin)
const updatePost = asyncHandler(async (req, res) => {
  const post = await BlogPost.findById(req.params.id);
  if (!post) throw new AppError('Post not found.', 404);

  const wasPublished = post.status === 'published';
  const allowed = ['title', 'excerpt', 'content', 'category', 'status', 'coverImage'];
  allowed.forEach((f) => { if (req.body[f] !== undefined) post[f] = req.body[f]; });
  if (!wasPublished && post.status === 'published' && !post.publishedAt) post.publishedAt = new Date();
  await post.save();
  return ok(res, post, 'Post saved.');
});

// DELETE /api/blog/:id (Super Admin)
const deletePost = asyncHandler(async (req, res) => {
  const post = await BlogPost.findById(req.params.id);
  if (!post) throw new AppError('Post not found.', 404);
  await post.deleteOne();
  return ok(res, null, 'Post deleted.');
});

module.exports = {
  listPublishedPages, getPublishedPage, adminListPages, createPage, updatePage, deletePage,
  listPublishedPosts, getPublishedPost, adminListPosts, createPost, updatePost, deletePost
};
