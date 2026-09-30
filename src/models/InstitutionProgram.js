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
    hostel: { enabled: { type: Boolean, default: false }, amount: { type: Number, min: 0, default: 0 }, recurrence: { type: String, enum: ['one_time', 'every_cycle'], default: 'one_time' } },
    transport: { enabled: { type: Boolean, default: false }, amount: { type: Number, min: 0, default: 0 }, recurrence: { type: String, enum: ['one_time', 'every_cycle'], default: 'one_time' } },
    library: { enabled: { type: Boolean, default: false }, amount: { type: Number, min: 0, default: 0 } },
    activity: { enabled: { type: Boolean, default: false }, amount: { type: Number, min: 0, default: 0 } }
  },
  active: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Professional fee-plan configuration (spec 15D.7) — additive, backward compatible. Every
  // existing program keeps working unset (billingFrequency defaults to 'monthly', matching the
  // old "installments spread monthly from admission" behavior) — see utils/feeSchedule.js.
  billingFrequency: { type: String, enum: ['monthly', 'term', 'semester', 'quarterly', 'biannual', 'annual', 'one_time', 'custom'], default: 'monthly' },
  billingIntervalCount: { type: Number, min: 1, default: 1 }, // only used when billingFrequency === 'custom' (every N months)
  academicYearStart: { type: Date, default: null },
  academicYearEnd: { type: Date, default: null },
  firstDueDate: { type: Date, default: null },
  invoiceGenerationDay: { type: Number, min: 1, max: 28, default: 1 }, // day-of-cycle an invoice is generated
  dueDay: { type: Number, min: 1, max: 28, default: 10 }, // day-of-cycle payment is due
  gracePeriodDays: { type: Number, min: 0, default: 0 },
  numberOfTerms: { type: Number, min: 1, default: 1 }, // for term/semester programs
  installmentsPerBillingCycle: { type: Number, min: 1, default: 1 },
  autoGenerateInvoices: { type: Boolean, default: true },
  autoSendReminders: { type: Boolean, default: true },
  lateFeeEnabled: { type: Boolean, default: false },
  lateFeeType: { type: String, enum: ['fixed', 'percentage'], default: 'fixed' },
  lateFeeValue: { type: Number, min: 0, default: 0 },
  maximumLateFee: { type: Number, min: 0, default: null },
  minimumPartialPayment: { type: Number, min: 0, default: 0 },
  // What happens to a student's access at THIS institution once a fee is overdue — never touches
  // another institution's access, and never suspends the whole account (spec 15D.7 lifecycle).
  accessRestrictionPolicy: {
    type: String,
    enum: ['none', 'warning', 'block_materials', 'block_assignments', 'block_exams', 'block_live_classes', 'block_certificates', 'block_all'],
    default: 'block_all'
  },
  reminderRules: {
    daysBeforeDue: [{ type: Number }],
    onDueDate: { type: Boolean, default: true },
    afterGracePeriod: { type: Boolean, default: true }
  }
}, { timestamps: true });
schema.index({ institution: 1, name: 1 }, { unique: true });
module.exports = mongoose.model('InstitutionProgram', schema);
