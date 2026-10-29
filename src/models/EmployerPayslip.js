const mongoose = require('mongoose');

// Master 12.13 (optional) salary management: one monthly payslip per employee of the employer,
// with allowances, bonus, deductions, leave and attendance. The employee confirms receipt, which
// feeds the employer's "On-time Salary" trust factor.
const lineSchema = new mongoose.Schema({ label: { type: String, required: true }, amount: { type: Number, required: true, min: 0 } }, { _id: false });

const employerPayslipSchema = new mongoose.Schema(
  {
    employer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employment: { type: mongoose.Schema.Types.ObjectId, ref: 'Employment', required: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    currency: { type: String, default: 'PKR' },
    basic: { type: Number, required: true, min: 0 },
    allowances: [lineSchema],
    bonus: { type: Number, default: 0, min: 0 },
    deductions: [lineSchema],
    workingDays: { type: Number, default: 0, min: 0, max: 31 },
    presentDays: { type: Number, default: 0, min: 0, max: 31 },
    leaveDays: { type: Number, default: 0, min: 0, max: 31 },
    absentDays: { type: Number, default: 0, min: 0, max: 31 },
    gross: { type: Number, default: 0 },
    net: { type: Number, default: 0 },
    note: { type: String, default: '' },
    status: { type: String, enum: ['draft', 'issued', 'paid'], default: 'draft', index: true },
    issuedAt: { type: Date, default: null },
    paidOn: { type: Date, default: null },
    paymentRef: { type: String, default: '' },
    employeeConfirmation: { received: { type: Boolean, default: null }, at: { type: Date, default: null }, note: { type: String, default: '' } },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);
employerPayslipSchema.index({ employment: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('EmployerPayslip', employerPayslipSchema);
