const mongoose = require('mongoose');

// Transport Management (spec 15D.12) — vehicles, drivers, routes, pickup points. GPS tracking
// is explicitly "Optional" in the spec and needs real hardware (a GPS unit per vehicle), so it
// is intentionally not built here — see stopPoints for the software-only routing/pickup list.
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
    stopPoints: [{ name: String, time: String }], // ordered pickup points, e.g. "Gulberg — 7:15am"
    assignedStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    monthlyFee: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'maintenance', 'retired'], default: 'active' },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

vehicleSchema.index({ institution: 1, vehicleNumber: 1 }, { unique: true });

module.exports = mongoose.model('Vehicle', vehicleSchema);
