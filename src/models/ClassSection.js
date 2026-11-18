const mongoose = require('mongoose');

const classSectionSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    campus: { type: mongoose.Schema.Types.ObjectId, ref: 'Campus', default: null },
    name: { type: String, required: true }, // e.g. "Grade 10 - A", "BSCS Semester 5"
    academicYear: { type: String, default: '' }, // e.g. "2025-2026"
    classTeacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Master 15A.5: the class belongs to a program and a semester/term.
    program: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionProgram', default: null },
    term: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicTerm', default: null },
    session: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ClassSection', classSectionSchema);
