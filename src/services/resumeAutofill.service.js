// Builds CV content from the user's own platform records — nothing invented:
// education from institution memberships, certifications from issued certificates, experience
// from internship certificates, skills/languages/career goal from the student profile and
// portfolio items from verified achievements.
const model = (n) => require(`../models/${n}`);
const year = (d) => (d ? new Date(d).getFullYear() : '');
const month = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '');
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);

async function draftFor(user) {
  const [profile, memberships, certificates, internships, achievements] = await Promise.all([
    model('StudentProfile').findOne({ user: user._id }).lean(),
    model('StudentInstitutionMembership').find({ student: user._id, status: { $in: ['active', 'withdrawal_requested', 'transfer_requested', 'withdrawn', 'transferred', 'graduated', 'completed'] } }).populate('institution', 'name').sort({ joinedAt: -1 }).lean(),
    model('Certificate').find({ student: user._id, status: 'active' }).populate('institution', 'name').sort({ issueDate: -1 }).lean(),
    model('InternshipCertificate').find({ student: user._id, status: 'active' }).sort({ endDate: -1 }).lean(),
    model('Achievement').find({ student: user._id, verificationStatus: 'verified' }).sort({ date: -1 }).lean()
  ]);
  const education = memberships.filter((m) => m.institution).map((m) => ({
    institution: m.institution.name,
    degree: m.program || (m.isPrimary ? profile?.program : '') || '',
    year: m.leftAt ? `${year(m.joinedAt)}–${year(m.leftAt)}` : `${year(m.joinedAt || m.createdAt)}–present`
  }));
  const experience = internships.map((c) => ({ title: `${c.role} (Internship)`, company: c.organization, duration: `${month(c.startDate)} – ${month(c.endDate)}`, description: c.remarks || '' }));
  const certificationsList = certificates.map((c) => `${c.title}${c.institution ? ` — ${c.institution.name}` : ''}`);
  const skills = [...new Set([...list(profile?.skills), ...internships.flatMap((c) => c.skills || [])])];
  return {
    headline: profile?.careerGoal || '',
    location: [user.city, user.country].filter(Boolean).join(', '),
    education,
    experience,
    skills,
    languages: list(profile?.languages),
    certifications: certificationsList,
    portfolio: achievements.map((a) => ({ title: a.title, url: a.evidenceUrl || '', description: a.description || '' })),
    sources: { institutions: education.length, certificates: certificates.length, internships: internships.length, achievements: achievements.length }
  };
}

// Fills only what is empty / missing; never overwrites what the user wrote.
function mergeInto(target, draft) {
  const added = {};
  for (const key of ['headline', 'location']) if (!String(target[key] || '').trim() && draft[key]) { target[key] = draft[key]; added[key] = 1; }
  const keyOf = { education: (e) => `${e.institution}|${e.degree}`.toLowerCase(), experience: (e) => `${e.title}|${e.company}`.toLowerCase(), portfolio: (p) => String(p.title).toLowerCase(), skills: (s) => String(s).toLowerCase(), languages: (s) => String(s).toLowerCase(), certifications: (s) => String(s).toLowerCase() };
  for (const [key, fn] of Object.entries(keyOf)) {
    const have = new Set((target[key] || []).map(fn));
    const fresh = (draft[key] || []).filter((item) => !have.has(fn(item)));
    if (fresh.length) { target[key] = [...(target[key] || []), ...fresh]; added[key] = fresh.length; }
  }
  return added;
}

module.exports = { draftFor, mergeInto };
