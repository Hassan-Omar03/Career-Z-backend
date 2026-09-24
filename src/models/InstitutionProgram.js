const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  name: { type: String, required: true, trim: true },
  department: { type: String, required: true, trim: true },
  classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', required: true },
  durationTerms: { type: Number, required: true, min: 1, default: 8 },
  admissionFee: { type: Number, required: true, min: 0, default: 0 },
  totalTuitionFee: { type: Number, required: true, min: 1 },
  installments: { type: Number, required: true, min: 1, default: 8 },
  currency: { type: String, required: true, default: 'PKR' },
  additionalFees: {
    exam: { enabled: { type: Boolean, default: false }, amount: { type: Number, min: 0, default: 0 } },
    hostel: { enabled: { type: Boolean, default: false }, amount: { type: Number, min: 0, default: 0 } },
    transport: { enabled: { type: Boolean, default: false }, amount: { type: Number, min: 0, default: 0 } },
    library: { enabled: { type: Boolean, default: false }, amount: { type: Number, min: 0, default: 0 } },
    activity: { enabled: { type: Boolean, default: false }, amount: { type: Number, min: 0, default: 0 } }
  },
  active: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });
schema.index({ institution: 1, name: 1 }, { unique: true });
module.exports = mongoose.model('InstitutionProgram', schema);
