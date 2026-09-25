const mongoose = require('mongoose');

// Student Community (spec Part 10.20) — Study Groups. Course-linked and institution-scoped:
// a group always belongs to one course, so membership/visibility can be restricted to that
// course's own enrolled students and its own teacher, mirroring the pattern used by
// anonymousQuestion.controller.js / poll.controller.js.
const studyGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    subject: { type: String, default: '' },

    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdByRole: { type: String, enum: ['student', 'teacher'], default: 'student' },
    // AI Group Maker output is marked so the UI/teacher can tell an auto-balanced group apart
    // from one a student started themselves.
    aiGenerated: { type: Boolean, default: false },

    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    members: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        joinedAt: { type: Date, default: Date.now }
      }
    ],
    // Student-created groups can be open (instant join) or approval-gated; teacher-created
    // groups are always 'managed' — students never self-join/self-leave a teacher-assigned group.
    joinPolicy: { type: String, enum: ['open', 'approval', 'managed'], default: 'open' },
    pendingRequests: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        requestedAt: { type: Date, default: Date.now }
      }
    ],
    maxMembers: { type: Number, default: 6, min: 2, max: 50 },

    status: { type: String, enum: ['active', 'archived'], default: 'active' },

    // Spec: project title/instructions/deadline + tasks, assigned by whoever runs the group.
    project: {
      title: { type: String, default: '' },
      instructions: { type: String, default: '' },
      deadline: { type: Date, default: null }
    },
    tasks: [
      {
        title: { type: String, required: true },
        assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        status: { type: String, enum: ['pending', 'in_progress', 'done'], default: 'pending' },
        dueDate: { type: Date, default: null },
        createdAt: { type: Date, default: Date.now }
      }
    ],
    // File/resource sharing — Cloudinary URLs from the existing platform-upload signature flow.
    resources: [
      {
        name: { type: String, required: true },
        url: { type: String, required: true },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        uploadedAt: { type: Date, default: Date.now }
      }
    ],
    // Group assignment submission (the deliverable for `project`) — one submission per group,
    // resubmittable, with per-member contribution notes for individual-contribution tracking.
    submission: {
      text: { type: String, default: '' },
      files: [{ type: String }],
      submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      submittedAt: { type: Date, default: null }
    },
    contributions: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        note: { type: String, default: '' },
        updatedAt: { type: Date, default: Date.now }
      }
    ],
    groupMarks: { type: Number, default: null, min: 0, max: 100 },
    individualMarks: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        marks: { type: Number, min: 0, max: 100, required: true },
        gradedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        gradedAt: { type: Date, default: Date.now }
      }
    ]
  },
  { timestamps: true }
);

studyGroupSchema.index({ institution: 1, course: 1, status: 1 });

module.exports = mongoose.model('StudyGroup', studyGroupSchema);
