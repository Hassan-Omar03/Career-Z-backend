// Marks the seeded TEST accounts as verified with a complete profile so testing can continue after
// mandatory verification was introduced. Touches only the emails below (or ones passed on the
// command line) — never other users.
//   npm run seed:complete-test-profiles            → dry run, shows what would change
//   npm run seed:complete-test-profiles -- --apply → writes
//   ... -- --apply someone@test.com                → extra test emails
require('dotenv').config();
const mongoose = require('mongoose');
const env = require('../config/env');
const User = require('../models/User');
const RoleRequest = require('../models/RoleRequest');
const UserProfile = require('../models/UserProfile');
const VerificationHistory = require('../models/VerificationHistory');
const { encrypt } = require('../utils/encryption');
const cfg = require('../config/accountVerification');

const SEED_EMAILS = [
  'gcuf.admin@careerz.local', 'hassanomar3345@gmail.com', 'ayesha.teacher@careerz.local', 'bilal.teacher@careerz.local',
  'sara.teacher@careerz.local', 'baitcvs@gmail.com', 'test@gmail.com', 'hostel.warden@careerz.local', 'gcuf.driver@careerz.local'
];
const TEST_CNIC = '3520200000001';

function valueFor(field, user) {
  const [first, ...rest] = (user.fullName || 'Test User').split(' ');
  const known = {
    firstName: first, lastName: rest.join(' ') || 'User', fullName: user.fullName, email: user.email, instituteEmail: user.email,
    contactNumber: user.phone || '+923000000000', parentContactNumber: '+923000000000', officialContactNumber: user.phone || '+923000000000',
    city: 'Faisalabad', province: 'Punjab', country: 'Pakistan', fatherName: 'Test Father', graduationYear: '2015',
    instituteName: 'Government College University Faisalabad', representativeName: user.fullName, location: 'https://maps.google.com/?q=31.4167,73.0700'
  };
  if (known[field.key]) return known[field.key];
  if (field.type === 'select') return field.options[0];
  if (field.type === 'date') return '1995-01-01';
  if (field.pattern === 'phone') return '+923000000000';
  if (field.pattern === 'email') return user.email;
  if (field.pattern === 'url') return 'https://careerz.pk';
  return `Test ${field.label.toLowerCase()}`;
}

async function run() {
  const apply = process.argv.includes('--apply');
  const emails = [...SEED_EMAILS, ...process.argv.slice(2).filter((a) => a.includes('@'))].map((e) => e.toLowerCase());
  await mongoose.connect(env.mongoUri);
  const users = await User.find({ email: { $in: emails } });
  for (const user of users) {
    const roles = user.roles.filter((r) => cfg.VERIFIED_ROLES.includes(r));
    for (const role of roles) {
      const request = await RoleRequest.findOne({ user: user._id, requestedRole: role }).sort({ createdAt: -1 });
      const profile = await UserProfile.findOne({ user: user._id, role });
      const action = [];
      if (!request || request.status !== 'approved') action.push(`request ${request?.status || 'none'} → approved`);
      if (!profile?.completed) action.push(`profile ${profile?.percent || 0}% → complete`);
      console.log(`${apply ? '[APPLY]' : '[DRY]'} ${user.email} / ${role}: ${action.join(', ') || 'already done'}`);
      if (!apply || !action.length) continue;

      let req = request;
      if (!req || req.status !== 'approved') {
        const previous = req?.status || '';
        if (!req) req = new RoleRequest({ user: user._id, requestedRole: role, subtype: cfg.SUBTYPES[role]?.[0] || '' });
        Object.assign(req, { status: 'approved', approvedAt: new Date(), reviewedAt: new Date(), reviewNotes: 'Test account — approved by seed.', legacy: true });
        await req.save();
        await VerificationHistory.create({ user: user._id, role, request: req._id, previousStatus: previous, newStatus: 'approved', remarks: 'Test account approved by seed script.' });
      }
      const doc = profile || new UserProfile({ user: user._id, role, subtype: req.subtype || '' });
      const fields = { ...(doc.fields || {}) };
      const sensitive = { ...(doc.sensitive || {}) };
      for (const f of cfg.profileFields(role, req.subtype || '')) {
        if (f.sensitive) { if (!sensitive[f.key]?.encrypted) sensitive[f.key] = { encrypted: encrypt(TEST_CNIC), last4: TEST_CNIC.slice(-4) }; }
        else if (!String(fields[f.key] ?? '').trim()) fields[f.key] = valueFor(f, user);
      }
      Object.assign(doc, { fields, sensitive, completed: true, completedAt: doc.completedAt || new Date(), percent: 100 });
      doc.markModified('fields'); doc.markModified('sensitive');
      await doc.save();
    }
  }
  const missing = emails.filter((e) => !users.some((u) => u.email === e));
  if (missing.length) console.log('Not found (skipped):', missing.join(', '));
  if (!apply) console.log('Dry run only — add --apply to write.');
  await mongoose.disconnect();
}

run().catch(async (err) => { console.error(err); await mongoose.disconnect(); process.exit(1); });
