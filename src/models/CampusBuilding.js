const mongoose = require('mongoose');

// Virtual Campus Tour (spec Part 11.12 / Institution dashboard #15) — a real, interactive 3D
// map built from the institution's own building data (name, type, position, floors), rendered
// with Three.js on the frontend. Not a generic stock 3D model and not 360° photography (this app
// has no way to guarantee an institution owns panorama camera equipment) — a real WebGL scene
// driven entirely by real institution-entered data, honest about what it is.
const campusBuildingSchema = new mongoose.Schema(
  {
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
    name: { type: String, required: true },
    type: {
      type: String,
      enum: ['academic', 'library', 'lab', 'hostel', 'sports', 'admin', 'cafeteria', 'auditorium', 'other'],
      default: 'academic'
    },
    color: { type: String, default: '#4b7bec' }, // hex, institution's choice
    positionX: { type: Number, default: 0 }, // grid units on the campus ground plane
    positionZ: { type: Number, default: 0 },
    width: { type: Number, default: 4 },
    depth: { type: Number, default: 4 },
    floors: { type: Number, default: 1 },
    description: { type: String, default: '' },
    photo: { type: String, default: null }, // optional real photo (base64 data URI), shown in the info panel when clicked
    order: { type: Number, default: 0 }
  },
  { timestamps: true }
);

module.exports = mongoose.model('CampusBuilding', campusBuildingSchema);
