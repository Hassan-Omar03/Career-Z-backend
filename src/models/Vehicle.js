const mongoose = require('mongoose');

// Transport Management (spec 15D.12) — vehicles, drivers, routes, pickup points. Live GPS
// tracking (see TransportJourney/TransportLocationPing) starts in manual/simulated-location mode
// — staff enter coordinates themselves until a real GPS device feed is wired to the same
// ping endpoint later; nothing about the tracking model changes when that happens.
const vehicleSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    vehicleNumber: { type: String, required: true },
    type: { type: String, enum: ['bus', 'van', 'car'], default: 'bus' },
    capacity: { type: Number, default: 0 },
    driverName: { type: String, default: '' },
    driverPhone: { type: String, default: '' },
    driverLicenseNo: { type: String, default: '' },
    routeName: { type: String, default: '' },
    // lat/lng are optional — when set, live tracking can alert "near pickup/drop point";
    // when left blank the route still works, just without that specific proximity alert.
    stopPoints: [{ name: String, time: String, lat: Number, lng: Number }],
    assignedStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    monthlyFee: { type: Number, default: 0 },
    // Optional — if set, a journey running longer than this shows a (computed-on-read, not
    // push-alerted — no background job scheduler exists) "delayed" flag.
    expectedDurationMinutes: { type: Number, default: null },
    status: { type: String, enum: ['active', 'maintenance', 'retired'], default: 'active' },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

vehicleSchema.index({ institution: 1, vehicleNumber: 1 }, { unique: true });

module.exports = mongoose.model('Vehicle', vehicleSchema);
