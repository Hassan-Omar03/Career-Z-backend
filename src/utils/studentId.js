const Institution = require('../models/Institution');

// Master 15D.3 "Student ID Generation": PREFIX-YEAR-0001, numbered per institution without gaps from
// two admissions at once (atomic counter).
function prefixFor(institution) {
  if (institution.studentIdPrefix) return institution.studentIdPrefix;
  const initials = String(institution.name || '').split(/\s+/).map((w) => w.replace(/[^A-Za-z]/g, '')[0] || '').join('').toUpperCase().slice(0, 4);
  return initials || 'STU';
}
async function nextStudentId(institutionId, now = new Date()) {
  const inst = await Institution.findByIdAndUpdate(institutionId, { $inc: { studentIdSeq: 1 } }, { new: true }).select('name studentIdPrefix studentIdSeq');
  return `${prefixFor(inst)}-${now.getFullYear()}-${String(inst.studentIdSeq).padStart(4, '0')}`;
}
module.exports = { nextStudentId, prefixFor };
