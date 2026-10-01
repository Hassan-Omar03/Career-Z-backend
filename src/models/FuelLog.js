const mongoose = require('mongoose');

// Transport Fuel Management (spec gap: "Fuel management missing"). One entry per fill-up.
const fuelLogSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    date: { type: Date, required: true, default: Date.now },
    liters: { type: Number, required: true, min: 0 },
    costPerLiter: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
    odometerReading: { type: Number, default: null },
    filledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    notes: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('FuelLog', fuelLogSchema);
