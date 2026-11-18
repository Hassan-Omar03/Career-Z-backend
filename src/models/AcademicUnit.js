const mongoose = require('mongoose');

// An institution's academic structure (master 15A.5): Campus > Faculty > Department > Program >
// Semester/Term > Class > Section > Subject. Programs (InstitutionProgram), campuses (Campus) and class
// sections (ClassSection) already have their own records; the levels that had none live here, one
// collection per level so each can be listed and linked on its own.
const { Schema } = mongoose;
const ref = (model) => ({ type: Schema.Types.ObjectId, ref: model, default: null });
const common = {
  institution: { type: Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  code: { type: String, default: '', trim: true, maxlength: 30 },
  active: { type: Boolean, default: true },
  createdBy: ref('User')
};

// Master 15A.11: academic years (2025-2026) and their Spring / Fall / Summer sessions. One may be marked
// current; terms and classes belong to a session.
const AcademicSession = mongoose.model('AcademicSession', new Schema({
  ...common,
  kind: { type: String, enum: ['year', 'spring', 'fall', 'summer', 'other'], default: 'year' },
  startDate: { type: Date, default: null },
  endDate: { type: Date, default: null },
  current: { type: Boolean, default: false }
}, { timestamps: true }));
const Faculty = mongoose.model('Faculty', new Schema({ ...common, campus: ref('Campus'), head: ref('User') }, { timestamps: true }));
const Department = mongoose.model('Department', new Schema({ ...common, faculty: ref('Faculty'), head: ref('User') }, { timestamps: true }));
const AcademicTerm = mongoose.model('AcademicTerm', new Schema({
  ...common,
  program: ref('InstitutionProgram'),
  session: ref('AcademicSession'),
  order: { type: Number, default: 1, min: 1, max: 40 },
  startDate: { type: Date, default: null },
  endDate: { type: Date, default: null }
}, { timestamps: true }));
const Subject = mongoose.model('Subject', new Schema({
  ...common,
  department: ref('Department'),
  program: ref('InstitutionProgram'),
  term: ref('AcademicTerm'),
  classSection: ref('ClassSection'),
  teacher: ref('User'),
  creditHours: { type: Number, default: 0, min: 0, max: 30 }
}, { timestamps: true }));

module.exports = { AcademicSession, Faculty, Department, AcademicTerm, Subject };
