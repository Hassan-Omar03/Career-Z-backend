const mongoose = require('mongoose');

// Transport maintenance/service history (spec gap: "Vehicle maintenance/fitness/insurance records
// nahi"). Insurance/fitness EXPIRY DATES live directly on Vehicle (single current value); this
// log is the append-only history of actual service work done.
const vehicleMaintenanceLogSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    type: { type: String, enum: ['service', 'repair', 'inspection', 'insurance_renewal', 'fitness_renewal', 'other'], default: 'service' },
    date: { type: Date, required: true, default: Date.now },
    description: { type: String, default: '' },
    cost: { type: Number, default: 0 },
    odometerReading: { type: Number, default: null },
    nextDueDate: { type: Date, default: null },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('VehicleMaintenanceLog', vehicleMaintenanceLogSchema);
