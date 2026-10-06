const mongoose = require('mongoose');
const crypto = require('crypto');

const rowSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  subject: { type: String, required: true }, term: { type: String, default: '' },
  academicSession: { type: String, default: '' }, creditHours: { type: Number, required: true },
  marksObtained: { type: Number, required: true }, totalMarks: { type: Number, required: true },
  percentage: { type: Number, required: true }, grade: { type: String, required: true }, gradePoints: { type: Number, required: true }
}, { _id: false });

const schema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  programName: { type: String, default: '' }, rollNumber: { type: String, default: '' },
  rows: [rowSchema], semesterSummaries: [{ academicSession: { type: String, default: '' }, term: String, credits: Number, gpa: Number }],
  totalCredits: { type: Number, required: true }, cgpa: { type: Number, required: true },
  status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  issueDate: { type: Date, default: Date.now },
  verifyCode: { type: String, required: true, unique: true, default: () => crypto.randomBytes(10).toString('hex') },
  issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });
schema.index({ student: 1, institution: 1 }, { unique: true });
module.exports = mongoose.model('AcademicTranscript', schema);
