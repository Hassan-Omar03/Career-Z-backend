const verification = require('../config/accountVerification');

// Reference material the homepage assistant reads before answering: how CareerZ actually works.
// Account types, sub-types, required documents, review statuses and password rules are read from
// the live configuration, so the guide changes when the system does. This is source material
// for the AI, not prepared answers: the AI writes every reply itself.

// What each account can do, as built (dashboards and APIs in this codebase).
const CAPABILITIES = {
  student: 'join institutions and courses (several at once, including independent tutors); see classes, timetable, attendance, homework, exams, results and certificates; digital student ID and digital locker; pay fees online; AI study tools using their own AI key; find jobs and internships, apply, track applications and interviews; CV builder with versions, ten downloadable CV designs and a public portfolio; scholarships; marketplace; study groups and campus life',
  parent: 'link to their children (approval required); see each child\'s attendance, homework, exams, results, fees and timetable; pay fees (shown as paid by the parent); message teachers and request parent-teacher meetings; approve independent tutoring for a minor; rate teachers',
  teacher: 'work at institutions (job offers, contracts, payslips) or teach independently: an independent teacher creates their own course, invites a student by email with an optional fee and currency; the student accepts (a parent must approve for a student under 18); the student or a parent pays the fee online from their Fees page and the teacher sees it as paid and by whom; create courses, lessons and live classes; take attendance; set and grade homework and exams (with a check for copied answers); AI Teacher tools (notes, quizzes, lesson plans, slides, media) using their own or the institution\'s AI key; verified teaching hours, Bronze/Silver/Gold/Verified Expert badges and an optional public portfolio',
  institute: 'run admissions, classes and timetable, student records and class promotion, fees and receipts, staff roles and permissions, payroll, examinations and certificates, library, hostel, transport, inventory, health records, events and help desk, placement office, teacher performance reviews, an AI operations report, its own public website page, and subscription plans (Free, Basic, Professional, Enterprise)',
  agent: 'education agents (individual or registered agency) help students with institutions and admissions',
  donor: 'individual donors or organizations post scholarships, review applicants, sponsor students and see where their money went',
  marketplace: 'individual sellers or businesses list education products (books, equipment and more); listings are reviewed before they go live'
};

function guide() {
  const types = Object.entries(verification.ACCOUNT_TYPES).map(([key, t]) => {
    const subtypes = verification.SUBTYPES[t.role] || [];
    const docs = (subtypes.length ? subtypes : ['']).map((sub) => {
      const groups = verification.documentRequirements(t.role, sub);
      const list = groups.map((g) => `${g.label}${g.mandatory === false ? ' (optional)' : ''}`).join('; ');
      return subtypes.length ? `${sub}: ${list}` : list;
    }).join(' | ');
    return `- ${t.label} account${subtypes.length ? ` (kinds: ${subtypes.join(', ')})` : ''}. Can: ${CAPABILITIES[key] || '—'}. Documents for verification: ${docs || 'none'}.`;
  }).join('\n');
  return `CAREERZ PLATFORM GUIDE (from the live system configuration)
CareerZ (CareerZ.pk) is an education and careers platform connecting students, parents, teachers, institutes, education agents, donors and marketplace sellers.

Signing up: open /signup, choose an account type, enter name, email, a password, country and city (both required) and accept the terms. Password rules: at least 8 characters with one capital letter, one small letter and one special character. A student also gives a parent or guardian contact. Google, Facebook and Microsoft sign-in are available.
After signing up: upload the verification documents for the account type, then CareerZ staff review them. Review statuses: ${verification.STATUSES.join(', ')}. After approval the person completes their profile and uses their dashboard. Some features stay locked until approval.

Account types:
${types}

Public pages visitors can open: /signup, /login, /jobs, /scholarships, /institutions, /courses, /marketplace, /agent-program, /donor-program, /become-a-seller, /about, /faq, /help, /contact, /verify-certificate/<code>, /teacher/<id> (teacher portfolios), /i/<subdomain> (institute websites).
AI features inside dashboards use the user's or institution's own AI key (CareerZ does not charge for AI).
Payments: fees and purchases are paid online through the payment options enabled on the platform, or reported as bank/cash payments that the institution verifies.`;
}

module.exports = { guide };
