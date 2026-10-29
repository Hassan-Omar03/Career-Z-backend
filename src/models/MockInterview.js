const mongoose = require('mongoose');

// AI Mock Interview: the AI asks role-specific questions, the candidate answers (typed or
// spoken), every answer is scored with feedback and a confidence level, and the session ends
// with an overall summary. Runs on the candidate's own AI key.
const answerSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    kind: { type: String, default: 'general' }, // technical / behavioural / hr / situational / general
    answer: { type: String, default: '' },
    spoken: { type: Boolean, default: false },
    seconds: { type: Number, default: null },
    score: { type: Number, default: null }, // 0-10
    feedback: { type: String, default: '' },
    betterAnswer: { type: String, default: '' },
    confidence: { level: { type: String, enum: ['', 'low', 'medium', 'high'], default: '' }, score: { type: Number, default: null }, signals: [{ type: String }] },
    answeredAt: { type: Date, default: null }
  },
  { _id: false }
);

const mockInterviewSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, required: true, trim: true },
    level: { type: String, enum: ['fresher', 'junior', 'mid', 'senior'], default: 'junior' },
    focus: { type: String, enum: ['mixed', 'technical', 'behavioural', 'hr'], default: 'mixed' },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
    questions: [answerSchema],
    status: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress', index: true },
    summary: {
      overallScore: { type: Number, default: null }, // 0-100
      confidence: { type: String, default: '' },
      confidenceScore: { type: Number, default: null },
      verdict: { type: String, default: '' },
      strengths: [{ type: String }],
      improvements: [{ type: String }],
      nextSteps: [{ type: String }]
    },
    completedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('MockInterview', mockInterviewSchema);
