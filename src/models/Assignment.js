const mongoose = require('mongoose');

const assignmentSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    dueDate: { type: Date, default: null },
    maxMarks: { type: Number, default: 100 },
    attachments: [{ name: String, url: String }]
  },
  { timestamps: true }
);

module.exports = mongoose.model('Assignment', assignmentSchema);
