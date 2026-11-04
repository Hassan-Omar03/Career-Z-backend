const mongoose = require('mongoose');

// A freelancer's offer on a job posted with the type "freelance".
const schema = new mongoose.Schema({
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  freelancer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  coverLetter: { type: String, required: true, trim: true, maxlength: 3000 },
  currency: { type: String, default: 'PKR' },
  fee: { type: Number, required: true, min: 1 },
  milestones: [{ title: { type: String, required: true, trim: true, maxlength: 120 }, amount: { type: Number, required: true, min: 1 }, dueDate: { type: Date, default: null } }],
  attachments: [{ name: { type: String, trim: true, maxlength: 120 }, url: { type: String, trim: true, maxlength: 600 } }],
  status: { type: String, enum: ['submitted', 'accepted', 'declined', 'withdrawn'], default: 'submitted', index: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'FreelanceOrder', default: null }
}, { timestamps: true });
schema.index({ job: 1, freelancer: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['submitted', 'accepted'] } } });

module.exports = mongoose.model('FreelanceProposal', schema);
