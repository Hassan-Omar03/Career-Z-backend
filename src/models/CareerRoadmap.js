const mongoose = require('mongoose');

// A student's plan towards a target career: ordered steps (skills, courses, projects,
// certifications, experience) with target dates and progress. Steps come from the student or
// from the student's own/institution AI provider — never invented by the platform.
const stepSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  detail: { type: String, default: '', maxlength: 1000 },
  category: { type: String, enum: ['skill', 'course', 'project', 'certification', 'experience', 'other'], default: 'skill' },
  targetDate: { type: Date, default: null },
  status: { type: String, enum: ['todo', 'in_progress', 'done'], default: 'todo' },
  completedAt: { type: Date, default: null }
});

const roadmapSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    targetCareer: { type: String, required: true, trim: true, maxlength: 120 },
    horizonMonths: { type: Number, default: 6, min: 1, max: 60 },
    source: { type: String, enum: ['manual', 'ai'], default: 'manual' },
    aiProvider: { type: String, default: '' },
    steps: { type: [stepSchema], validate: [(v) => v.length <= 40, 'A roadmap can have at most 40 steps.'] }
  },
  { timestamps: true }
);

module.exports = mongoose.model('CareerRoadmap', roadmapSchema);
