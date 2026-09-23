const mongoose = require('mongoose');

// Real location history for a journey — auto-deleted after 30 days (spec: Parent Safety "location
// history limited period, recommended 30 days, phir automatically delete") via a TTL index, not a
// manual cleanup job.
const transportLocationPingSchema = new mongoose.Schema(
  {
    journey: { type: mongoose.Schema.Types.ObjectId, ref: 'TransportJourney', required: true, index: true },
    vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    at: { type: Date, default: Date.now }
  }
);

transportLocationPingSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('TransportLocationPing', transportLocationPingSchema);
