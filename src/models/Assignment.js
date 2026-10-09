const mongoose = require('mongoose');

const assignmentSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    type: { type: String, enum: ['homework', 'assignment', 'project', 'worksheet', 'practical'], default: 'assignment' },
    description: { type: String, default: '' },
    dueDate: { type: Date, default: null },
    maxMarks: { type: Number, default: 100 },
    submissionMode: { type: String, enum: ['text', 'file', 'either', 'both'], default: 'either' },
    allowLate: { type: Boolean, default: false },
    published: { type: Boolean, default: true },
    rubric: [{ criterion: String, maxMarks: Number }],
    attachments: [{ name: String, url: String }]
  },
  { timestamps: true }
);

assignmentSchema.post('save',async function(){await require('../services/learningBackup.service').capture(this.course,this.$session()||null);});
assignmentSchema.pre('deleteOne',{document:true,query:false},async function(){await require('../services/learningBackup.service').capture(this.course,this.$session()||null);});
assignmentSchema.pre('findOneAndDelete',async function(){const item=await this.model.findOne(this.getFilter()).lean();if(item)await require('../services/learningBackup.service').capture(item.course,this.getOptions().session||null);});
module.exports = mongoose.model('Assignment', assignmentSchema);
