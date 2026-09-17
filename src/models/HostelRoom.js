const mongoose = require('mongoose');

// Hostel Management (spec 15D.11) — rooms/beds/occupancy. Only relevant to institutions that
// run a hostel, so this is opt-in data (no rooms created = feature simply unused).
const hostelRoomSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    building: { type: String, default: '' },
    roomNumber: { type: String, required: true },
    floor: { type: String, default: '' },
    capacity: { type: Number, required: true, min: 1 },
    occupants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    monthlyFee: { type: Number, default: 0 },
    warden: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['available', 'full', 'maintenance'], default: 'available' }
  },
  { timestamps: true }
);

hostelRoomSchema.index({ institution: 1, roomNumber: 1 }, { unique: true });

module.exports = mongoose.model('HostelRoom', hostelRoomSchema);
