const Enrollment = require('../models/Enrollment');
const StudentProfile = require('../models/StudentProfile');

// Institute courses belong to a class. Admission enrols a student in the courses that exist at
// that moment, so a course added or published later, or a student placed in the class later,
// is matched here. A dropped or completed enrollment is left as it is.
async function enrollSectionStudents(course) {
  if (!course?.institution || !course.classSection || !course.published) return 0;
  const students = await StudentProfile.find({ classSection: course.classSection, status: { $nin: ['graduated', 'transferred'] } }).select('user').lean();
  if (!students.length) return 0;
  const result = await Enrollment.bulkWrite(students.map((s) => ({ updateOne: { filter: { student: s.user, course: course._id }, update: { $setOnInsert: { student: s.user, course: course._id, status: 'active' } }, upsert: true } })));
  return result.upsertedCount || 0;
}

async function enrollStudentInSection(studentId, sectionId) {
  if (!sectionId) return;
  const courses = await require('../models/Course').find({ classSection: sectionId, published: true }).select('_id').lean();
  if (!courses.length) return;
  await Enrollment.bulkWrite(courses.map((c) => ({ updateOne: { filter: { student: studentId, course: c._id }, update: { $setOnInsert: { student: studentId, course: c._id, status: 'active' } }, upsert: true } })));
}

module.exports = { enrollSectionStudents, enrollStudentInSection };
