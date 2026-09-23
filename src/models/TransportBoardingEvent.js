const mongoose = require('mongoose');

// A real, confirmed boarding/exit record — spec: "Boarding/exiting QR ... ya authorized staff
// confirmation se record ho." (NFC omitted — this project's own attendance spec already excluded
// physical NFC/RFID hardware for the same reason: no such hardware to genuinely integrate.)
const transportBoardingEventSchema = new mongoose.Schema(
  {
    journey: { type: mongoose.Schema.Types.ObjectId, ref: 'TransportJourney', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    event: { type: String, enum: ['boarded', 'exited'], required: true },
    method: { type: String, enum: ['qr', 'staff_confirm'], required: true },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model('TransportBoardingEvent', transportBoardingEventSchema);
