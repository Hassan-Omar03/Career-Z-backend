const mongoose = require('mongoose');

// Digital permission slip (spec Part 11.14) — a parent grants or denies consent for a specific
// child activity (school trip, event, photo use, medical treatment, etc.) with a typed
// e-signature, replacing the paper permission-slip workflow.
const parentPermissionSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    request:{type:mongoose.Schema.Types.ObjectId,ref:'FamilyConsentRequest'}, institution:{type:mongoose.Schema.Types.ObjectId,ref:'Institution'}, history:[{decision:String,signedName:String,at:Date}],
    type: { type: String, enum: ['trip', 'event', 'competition', 'photo', 'medical', 'other'], required: true },
    title: { type: String, required: true, trim: true },
    details: { type: String, default: '' },
    decision: { type: String, enum: ['granted', 'denied'], required: true },
    // Typed full-name e-signature + timestamp — the digital equivalent of a signed paper slip.
    signedName: { type: String, required: true, trim: true },
    signedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

parentPermissionSchema.index({request:1,parent:1},{unique:true,partialFilterExpression:{request:{$type:'objectId'}}});
module.exports = mongoose.model('ParentPermission', parentPermissionSchema);
