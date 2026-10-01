const mongoose = require('mongoose');

// The agreed fee-plan SNAPSHOT for one student in one program (spec 15D.7 requirement: "Future
// plan changes must not silently alter already-accepted students' agreed fees"). Created once at
// admission acceptance (or manually by an institution for an already-enrolled student); every
// invoice generated afterwards reads its numbers from here, never from the live InstitutionProgram
// document, so a later program price change never rewrites what this student already agreed to.
const feeScheduleSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    program: { type: mongoose.Schema.Types.ObjectId, ref: 'InstitutionProgram', default: null },
    programName: { type: String, required: true },
    classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', default: null },

    currency: { type: String, required: true, default: 'USD' },
    totalProgramFee: { type: Number, required: true, min: 0 },
    billingFrequency: { type: String, enum: ['monthly', 'term', 'semester', 'quarterly', 'biannual', 'annual', 'one_time', 'custom'], required: true },
    billingIntervalCount: { type: Number, min: 1, default: 1 },
    numberOfTerms: { type: Number, min: 1, default: 1 },
    installmentsPerBillingCycle: { type: Number, min: 1, default: 1 },

    academicYearStart: { type: Date, default: null },
    academicYearEnd: { type: Date, default: null },
    firstDueDate: { type: Date, default: null },
    invoiceGenerationDay: { type: Number, default: 1 },
    dueDay: { type: Number, default: 10 },
    gracePeriodDays: { type: Number, default: 0 },
    // Whether the CURRENT billing period's invoice generates automatically (lazily, the next time
    // anyone reads this student's/institution's fees) once its start date arrives, vs. only ever
    // via the institution's manual Generate Current/Next buttons.
    autoGenerateInvoices: { type: Boolean, default: true },
    autoSendReminders: { type: Boolean, default: true },

    lateFeeEnabled: { type: Boolean, default: false },
    lateFeeType: { type: String, enum: ['fixed', 'percentage'], default: 'fixed' },
    lateFeeValue: { type: Number, default: 0 },
    maximumLateFee: { type: Number, default: null },
    // Smallest amount a student/parent may report as a partial payment (0 = no minimum) — never
    // applies to a payment that clears the full remaining balance, however small that is.
    minimumPartialPayment: { type: Number, default: 0 },

    accessRestrictionPolicy: {
      type: String,
      enum: ['none', 'warning', 'block_materials', 'block_assignments', 'block_exams', 'block_live_classes', 'block_certificates', 'block_all'],
      default: 'block_all'
    },
    reminderRules: {
      daysBeforeDue: [{ type: Number }],
      onDueDate: { type: Boolean, default: true },
      afterGracePeriod: { type: Boolean, default: true }
    },

    // One-time charges (admission/exam/hostel/transport/library/activity) billed once, in the
    // first generated period only — snapshotted the same way as everything else here.
    additionalFees: {
      admission: { enabled: { type: Boolean, default: false }, amount: { type: Number, default: 0 } },
      exam: { enabled: { type: Boolean, default: false }, amount: { type: Number, default: 0 } },
      hostel: { enabled: { type: Boolean, default: false }, amount: { type: Number, default: 0 }, securityDeposit: { type: Number, default: 0 }, messEnabled: { type: Boolean, default: false }, messMonthlyAmount: { type: Number, default: 0 }, recurrence: { type: String, enum: ['one_time', 'every_cycle'], default: 'every_cycle' } },
      transport: { enabled: { type: Boolean, default: false }, amount: { type: Number, default: 0 }, recurrence: { type: String, enum: ['one_time', 'every_cycle'], default: 'one_time' } },
      library: { enabled: { type: Boolean, default: false }, amount: { type: Number, default: 0 } },
      activity: { enabled: { type: Boolean, default: false }, amount: { type: Number, default: 0 } }
    },
    additionalFeesBilled: { type: Boolean, default: false }, // guards against re-billing on a later period

    // Every billing period already invoiced (e.g. '2026-03', '2026-Term1') — the real idempotency
    // guard, backed also by a unique index on Fee (schedule + billingPeriod + installmentNumber).
    periodsGenerated: [{ type: String }],

    status: { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

feeScheduleSchema.index({ institution: 1, student: 1, program: 1 }, { unique: true });
module.exports = mongoose.model('FeeSchedule', feeScheduleSchema);
