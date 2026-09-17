const mongoose = require('mongoose');
const crypto = require('crypto');

// Institution-scoped Complaint & Help Desk (spec 15D.16) — distinct from the platform-wide
// Complaint model (that one escalates to Super Admin about billing/fraud/harassment on the
// platform itself; this one is a school's own internal help desk for its students/parents/
// teachers/staff, with the exact categories and per-ticket number the spec asks for).
const helpDeskTicketSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    ticketNumber: { type: String, required: true, unique: true, default: () => `TKT-${crypto.randomBytes(4).toString('hex').toUpperCase()}` },
    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: {
      type: String,
      enum: ['academic', 'fee', 'teacher', 'student', 'staff', 'technical', 'harassment', 'discipline'],
      required: true
    },
    subject: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    status: { type: String, enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open' },
    priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolutionNotes: { type: String, default: '' },
    resolvedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('HelpDeskTicket', helpDeskTicketSchema);
