const mongoose = require('mongoose');

// Gap-free running numbers, such as receipt numbers.
const counterSchema = new mongoose.Schema({ _id: { type: String, required: true }, seq: { type: Number, default: 0 } });

module.exports = mongoose.model('Counter', counterSchema);
