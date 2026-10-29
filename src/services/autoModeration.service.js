const Product = require('../models/Product');
const RoleRequest = require('../models/RoleRequest');

// Publish automatically once the account is verified (owner's rule, master "AI Fraud Detection /
// Risk Scoring"): every listing is checked by these rules; it goes live at once unless a rule
// holds it, and only then a CareerZ admin is asked to look. Each rule adds points with a reason;
// reaching HOLD_AT points, or any rule marked `hold`, sends it to review.

const HOLD_AT = 40;
const BANNED = /\b(pistol|gun|rifle|bullets?|ammo|ammunition|weapons?|explosives?|drugs?|charas|heroin|cocaine|weed|marijuana|hash(ish)?|alcohol|liquor|wine|beer|vape|cigarettes?|tobacco|fake (degree|certificate|cnic|passport|id|documents?)|degree for sale|cnic for sale|leaked? (paper|exam)|exam paper (leak|for sale)|cracked (software|account)|hacked accounts?|replica|counterfeit|first copy|stolen)\b/i;
const MONEY_ASK = /(advance|registration|processing|security|booking)\s*(fee|payment|charges?|deposit)|send\s+(money|payment|rs|pkr)\s+first|pay\s+(before|in advance)|guaranteed\s+(scholarship|admission|visa|selection)|100%\s+(scholarship|admission|visa)/i;
const OFF_PLATFORM = /(whats\s*app|wa\.me|telegram|call\s+(me\s+)?(now|on)|contact\s+on|jazzcash|easypaisa)\s*[:\-]?\s*\+?\d[\d\s\-]{8,}|\+?92[\s-]?3\d{2}[\s-]?\d{7}|\b03\d{2}[\s-]?\d{7}\b/i;
const LINKS = /https?:\/\/|www\./i;

function flagger() {
  const out = [];
  return { out, add: (code, label, points, hold = false) => out.push({ code, label, points, hold }) };
}
const decide = (flags) => ({ flags, held: flags.some((f) => f.hold) || flags.reduce((s, f) => s + f.points, 0) >= HOLD_AT });

// Marketplace listing.
async function checkProduct(product) {
  const { out, add } = flagger();
  const text = `${product.title || ''}\n${product.description || ''}`;
  if (BANNED.test(text)) add('banned_item', 'Looks like an item that cannot be sold on CareerZ', 100, true);
  if (MONEY_ASK.test(text)) add('money_ask', 'Asks buyers for an advance or a fee outside the order', 60, true);
  if (OFF_PLATFORM.test(text)) add('off_platform', 'Pushes buyers to a phone, WhatsApp or wallet number', 30);
  if (LINKS.test(product.description || '')) add('external_link', 'Has a link to another website', 15);
  const price = Number(product.price);
  if (!(price > 0)) add('no_price', 'Price is zero', 40, true);
  if (price > 2000000) add('price_extreme', 'Price above PKR 2,000,000', 60, true);
  if (String(product.description || '').trim().length < 10) add('thin', 'Very short description', 10);
  const [dup, roleRequest, recentRejected, medianRows] = await Promise.all([
    Product.countDocuments({ _id: { $ne: product._id }, seller: product.seller, status: { $in: ['active', 'pending_approval', 'out_of_stock'] }, title: new RegExp(`^${String(product.title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }),
    RoleRequest.findOne({ user: product.seller, requestedRole: { $in: ['marketplace_seller', 'student'] }, status: 'approved' }).sort({ approvedAt: 1 }).select('approvedAt reviewedAt').lean(),
    Product.countDocuments({ seller: product.seller, status: 'rejected', updatedAt: { $gte: new Date(Date.now() - 30 * 864e5) } }),
    Product.find({ category: product.category, status: 'active', _id: { $ne: product._id }, currency: product.currency || 'PKR' }).select('price').limit(200).lean()
  ]);
  if (dup) add('duplicate', 'The seller already has a listing with this title', 30);
  if (recentRejected >= 2) add('repeat_rejected', 'The seller had 2 or more listings rejected this month', 50, true);
  const approvedAt = roleRequest?.approvedAt || roleRequest?.reviewedAt;
  if (approvedAt && Date.now() - new Date(approvedAt).getTime() < 7 * 864e5 && price > 50000) add('new_seller_high_price', 'New seller (under 7 days) with a price above PKR 50,000', 25);
  if (medianRows.length >= 5) {
    const s = medianRows.map((r) => r.price).sort((a, b) => a - b);
    const median = s[Math.floor(s.length / 2)];
    if (median > 0 && (price > median * 10 || price < median / 10)) add('price_unusual', `Price is far from similar items (usual about ${median})`, 20);
  }
  return decide(out);
}

// Agent scholarship listing.
function checkScholarship(s) {
  const { out, add } = flagger();
  const text = `${s.title || ''}\n${s.description || ''}\n${s.eligibility || ''}`;
  if (MONEY_ASK.test(text)) add('money_ask', 'Asks applicants for a fee or promises a guaranteed result', 60, true);
  if (OFF_PLATFORM.test(text)) add('off_platform', 'Pushes applicants to a phone or WhatsApp number', 30);
  if (String(s.description || '').trim().length < 40) add('thin', 'Very short description', 15);
  const amount = Number(s.amount || 0);
  if (amount > 10000000) add('amount_extreme', 'Very large amount', 40, true);
  if (s.deadline && new Date(s.deadline) < new Date()) add('deadline_past', 'The deadline has already passed', 40, true);
  if (s.externalUrl && !/^https:\/\//.test(s.externalUrl)) add('insecure_link', 'Application link is not https', 40, true);
  return decide(out);
}

module.exports = { HOLD_AT, checkProduct, checkScholarship };
