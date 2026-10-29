const mongoose = require('mongoose');

// Master 15A.6: in an academy the structure is Course → Batch → Students. A batch is one
// running group of a course: its teacher, days and times, dates, seats and fee.
const batchSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    schedule: [{ day: { type: String, enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], required: true }, start: { type: String, required: true }, end: { type: String, required: true }, _id: false }],
    mode: { type: String, enum: ['on_campus', 'online', 'hybrid'], default: 'on_campus' },
    room: { type: String, default: '' },
    meetingLink: { type: String, default: '' },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    seats: { type: Number, required: true, min: 1, max: 1000 },
    fee: {
      amount: { type: Number, default: 0, min: 0 },
      currency: { type: String, default: 'PKR' },
      period: { type: String, enum: ['one_time', 'monthly'], default: 'monthly' }
    },
    // auto: a seat is given at once while seats last; approval: the academy accepts each student.
    admission: { type: String, enum: ['auto', 'approval'], default: 'approval' },
    status: { type: String, enum: ['draft', 'open', 'closed', 'completed', 'cancelled'], default: 'open', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Batch', batchSchema);
