const mongoose = require('mongoose');

const jobApplicationSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    applicant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    coverLetter: { type: String, default: '' },
    resumeSnapshot: { type: mongoose.Schema.Types.Mixed, default: null }, // copy of the Resume at time of applying
    status: {
      type: String,
      // Master 12.10 Hiring Workflow. Stored values keep their original names so existing
      // records and features keep working: pending = Applied, viewed = Screening,
      // selected = Offer, hired = Joined.
      enum: ['pending', 'viewed', 'shortlisted', 'interview', 'final_interview', 'selected', 'accepted', 'hired', 'completed', 'rejected', 'withdrawn'],
      default: 'pending'
    },
    statusHistory: [{
      status: String, at: { type: Date, default: Date.now }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      byRole: { type: String, default: '' }, note: { type: String, default: '' }, _id: false
    }],
    // Joining is confirmed by the hiring organization, or by the candidate when an agent posted
    // the job; an agent alone cannot confirm it.
    // Agent jobs: the institute picks which applicants go forward; only then may the agent
    // interview them and move their stage.
    institutionSelection: { by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, at: { type: Date, default: null }, note: { type: String, default: '' }, direct: { type: Boolean, default: false } },
    // Agent jobs: the agent asks the institute to make this candidate an offer.
    offerRequest: { by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, at: { type: Date, default: null }, note: { type: String, default: '' } },
    // Messages between the hiring side and the candidate about this application.
    messages: [{ by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, side: { type: String, enum: ['candidate', 'employer'] }, name: String, text: String, at: { type: Date, default: Date.now } }],
    joining: {
      confirmed: { type: Boolean, default: false },
      confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      confirmedAt: { type: Date, default: null },
      via: { type: String, enum: ['', 'hiring_organization', 'candidate'], default: '' }
    }
  },
  { timestamps: true }
);

jobApplicationSchema.index({ job: 1, applicant: 1 }, { unique: true });

module.exports = mongoose.model('JobApplication', jobApplicationSchema);
