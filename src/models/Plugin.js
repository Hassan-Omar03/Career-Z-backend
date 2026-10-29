const mongoose = require('mongoose');

// Plugin System (Super Admin dashboard): an integration that receives CareerZ events at its
// own https address, signed with a secret (no outside code ever runs inside CareerZ).
// Built-in optional modules are switched on and off in plugins.service (Setting 'plugin_modules').
const pluginSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    url: { type: String, required: true },
    events: [{ type: String }],
    secret: { type: String, required: true, select: false },
    enabled: { type: Boolean, default: true, index: true },
    deliveries: [{
      event: String, status: Number, ok: Boolean, error: String, ms: Number, at: { type: Date, default: Date.now }
    }],
    failures: { type: Number, default: 0 }, // in a row; the plugin turns itself off at 20
    lastDeliveryAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Plugin', pluginSchema);
