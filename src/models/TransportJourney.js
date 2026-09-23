const mongoose = require('mongoose');

// One real trip of a vehicle (spec: Parent Safety "journey-scoped" tracking — location is only
// ever visible while a journey is in_progress, never an off-duty/idle position).
const transportJourneySchema = new mongoose.Schema(
  {
    vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    status: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress', index: true },
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, default: Date.now },
    endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    endedAt: { type: Date, default: null },
    lastPing: { lat: Number, lng: Number, at: Date },
    // Stop names already alerted "near" for this journey, so the same stop doesn't re-notify
    // every ping while the vehicle idles nearby.
    notifiedNearStops: [{ type: String }],
    qrToken: { type: String, default: null },
    qrExpiresAt: { type: Date, default: null },
    sosTriggeredAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('TransportJourney', transportJourneySchema);
