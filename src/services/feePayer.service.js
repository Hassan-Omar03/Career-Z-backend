const User = require('../models/User');
const ParentChildLink = require('../models/ParentChildLink');

// Who paid a fee, as families see it ("Paid by Ayesha Khan (Mother)"), and who must hear about a
// payment: the student, every approved parent/guardian, plus whoever receives the money.

const RELATION = { father: 'Father', mother: 'Mother', guardian: 'Guardian', sponsor: 'Sponsor' };

async function payerInfo(payerId, studentId) {
  if (!payerId) return null;
  const user = await User.findById(payerId).select('fullName').lean();
  if (!user) return null;
  if (String(payerId) === String(studentId)) return { id: String(payerId), name: user.fullName, role: 'Student' };
  const link = await ParentChildLink.findOne({ parent: payerId, student: studentId, status: 'approved' }).select('relationship').lean();
  return { id: String(payerId), name: user.fullName, role: link ? RELATION[link.relationship] || 'Parent' : 'Institution' };
}

// Notifications (in the { userId, payload } shape the payment webhooks send after commit):
// the payer gets a confirmation, everyone else is told who paid.
async function paidNotifications({ studentId, payerId, what, amountText, receipt, others = [] }) {
  const payer = await payerInfo(payerId, studentId);
  const guardians = await ParentChildLink.find({ student: studentId, status: 'approved' }).distinct('parent');
  const recipients = [...new Set([String(studentId), ...guardians.map(String), ...others.filter(Boolean).map(String)])];
  const by = payer ? ` paid by ${payer.name} (${payer.role})` : '';
  return recipients.map((userId) => ({
    userId,
    payload: userId === payer?.id
      ? { title: `Payment successful: ${what}`, body: `${amountText} paid.${receipt ? ` Receipt ${receipt}.` : ''}`, sentBy: null }
      : { title: `Fee paid: ${what}`, body: `${amountText}${by}.${receipt ? ` Receipt ${receipt}.` : ''}`, sentBy: payer ? payer.id : null }
  }));
}

// Adds paidByInfo ({ name, role }) to plain fee objects for one student's fee list.
async function withPayers(fees, studentId) {
  const cache = new Map();
  for (const fee of fees) {
    const id = fee.paidBy?._id || fee.paidBy;
    if (!id) continue;
    if (!cache.has(String(id))) cache.set(String(id), await payerInfo(id, studentId));
    fee.paidByInfo = cache.get(String(id));
  }
  // Each instalment records who reported or made it (recordedBy).
  for (const fee of fees) {
    for (const entry of fee.paymentHistory || []) {
      const id = entry.recordedBy?._id || entry.recordedBy;
      if (!id) continue;
      if (!cache.has(String(id))) cache.set(String(id), await payerInfo(id, studentId));
      entry.paidByInfo = cache.get(String(id));
    }
  }
  return fees;
}

// Independent tutoring fees as rows in the same fee list (they live on the tutoring link).
async function tutoringFeeRows(studentId) {
  const TeacherStudentLink = require('../models/TeacherStudentLink');
  const links = await TeacherStudentLink.find({ student: studentId, feeAmount: { $gt: 0 }, status: { $in: ['active', 'paused', 'completed'] } })
    .populate('teacher', 'fullName').populate('course', 'title').lean();
  const rows = [];
  for (const l of links) {
    rows.push({
      _id: l._id, kind: 'tutoring', tutoringLinkId: l._id,
      title: `Tuition — ${l.course?.title || l.subject || 'Independent tutoring'}`,
      teacherName: l.teacher?.fullName || '', institution: { name: `${l.teacher?.fullName || 'Tutor'} (independent tutor)` },
      amount: l.feeAmount, currency: l.feeCurrency, status: l.feePaidAt ? 'paid' : 'pending', paidAt: l.feePaidAt,
      receiptNumber: l.feeReceipt || '', paidByInfo: l.feePaidAt ? await payerInfo(l.feePaidBy || studentId, studentId) : null,
      createdAt: l.createdAt
    });
  }
  return rows;
}

// Same labels for an institution's list, where fees belong to many students.
async function withPayersMany(fees) {
  const cache = new Map();
  const label = async (payerId, studentId) => {
    const key = String(payerId) + ':' + String(studentId);
    if (!cache.has(key)) cache.set(key, await payerInfo(payerId, studentId));
    return cache.get(key);
  };
  const rows = fees.map((f) => (f.toObject ? f.toObject() : f));
  for (const fee of rows) {
    const studentId = fee.student?._id || fee.student;
    if (fee.paidBy) fee.paidByInfo = await label(fee.paidBy?._id || fee.paidBy, studentId);
    for (const entry of fee.paymentHistory || []) if (entry.recordedBy) entry.paidByInfo = await label(entry.recordedBy?._id || entry.recordedBy, studentId);
  }
  return rows;
}

module.exports = { payerInfo, paidNotifications, withPayers, withPayersMany, tutoringFeeRows };
