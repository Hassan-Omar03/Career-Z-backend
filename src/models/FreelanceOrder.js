const mongoose = require('mongoose');

const milestoneSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  amount: { type: Number, required: true, min: 1 },
  dueDate: { type: Date, default: null },
  deliveryDays: { type: Number, default: 0 },
  // pending: waiting for the client's payment · funded: CareerZ holds it · submitted: work delivered
  // revision: client asked for changes · approved: paid to the freelancer · disputed · refunded
  status: { type: String, enum: ['pending', 'funded', 'submitted', 'revision', 'approved', 'disputed', 'refunded'], default: 'pending' },
  fundedAt: { type: Date, default: null },
  feePaid: { type: Number, default: 0 },
  note: { type: String, trim: true, maxlength: 3000, default: '' },
  files: [{ name: { type: String, trim: true, maxlength: 120 }, url: { type: String, trim: true, maxlength: 600 } }],
  submittedAt: { type: Date, default: null },
  approvedAt: { type: Date, default: null },
  approvedBy: { type: String, default: '' },
  revisionNote: { type: String, trim: true, maxlength: 1000, default: '' },
  revisionsUsed: { type: Number, default: 0 }
});

const schema = new mongoose.Schema({
  buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  service: { type: mongoose.Schema.Types.ObjectId, ref: 'FreelanceService', default: null },
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
  proposal: { type: mongoose.Schema.Types.ObjectId, ref: 'FreelanceProposal', default: null },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  packageTier: { type: String, default: '' },
  category: { type: String, default: '' },
  currency: { type: String, default: 'PKR' },
  revisionsAllowed: { type: Number, default: 0 },
  milestones: { type: [milestoneSchema], validate: [(m) => m.length > 0, 'An order needs a milestone.'] },
  status: { type: String, enum: ['active', 'completed', 'cancelled', 'disputed'], default: 'active', index: true },
  messages: [{ from: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, text: { type: String, trim: true, maxlength: 2000 }, at: { type: Date, default: Date.now } }],
  firstResponseAt: { type: Date, default: null },
  review: { rating: { type: Number, min: 1, max: 5 }, text: { type: String, trim: true, maxlength: 1000 }, at: Date }
}, { timestamps: true });
schema.index({ 'milestones._id': 1 });

module.exports = mongoose.model('FreelanceOrder', schema);
