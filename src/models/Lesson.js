const mongoose = require('mongoose');

const lessonSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    title: { type: String, required: true },
    assignments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Assignment' }],
    exams: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Exam' }],
    module: { type: mongoose.Schema.Types.ObjectId, ref: 'LearningUnit', default: null },
    chapter: { type: mongoose.Schema.Types.ObjectId, ref: 'LearningUnit', default: null },
    content: { type: String, default: '' }, // text/notes
    videoDownloadAllowed: {type:Boolean,default:true},
    videoSources: [{label:String,url:String}],
    captions: [{language:String,label:String,url:String}],
    videoChapters: [{title:String,seconds:{type:Number,min:0}}],
    videoUrl: { type: String, default: null }, // external provider link (client-configured)
    resources: [{ name: String, url: String }],
    kind: { type: String, enum: ['lesson', 'slide_deck'], default: 'lesson', index: true },
    published: { type: Boolean, default: true, index: true },
    deck: {
      version: { type: Number, default: 1 },
      slides: [{
        title: { type: String, maxlength: 300 },
        bullets: [{ type: String, maxlength: 2000 }],
        background: { type: String, maxlength: 20 },
        accent: { type: String, maxlength: 20 },
        text: { type: String, maxlength: 20 },
        imageUrl: { type: String, maxlength: 3000 }
      }]
    },
    order: { type: Number, default: 0 },
    // Provenance shown to learners and reviewers.
    metadata: {
      author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // defaults to the course teacher
      authorName: { type: String, default: '', maxlength: 200 }, // e.g. an external author the teacher credits
      department: { type: String, default: '', maxlength: 200 },
      aiAssisted: { type: Boolean, default: false },
      aiNote: { type: String, default: '', maxlength: 500 }, // how AI was used
      lastReviewedAt: { type: Date, default: null },
      lastReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
    }
  },
  { timestamps: true }
);

lessonSchema.pre('validate',function(){for(const url of [this.videoUrl,...this.resources.map(r=>r.url),...this.videoSources.map(r=>r.url),...this.captions.map(r=>r.url)]){if(url&&!/^https?:\/\//i.test(url))this.invalidate('resources','Lesson files require HTTP/HTTPS links.');}});
// New lessons are credited to the course teacher (and the course department) unless set; an
// approval decision in the review workflow stamps the last-reviewed date and reviewer.
lessonSchema.pre('save', async function () {
  if (this.isNew && !this.metadata?.author) {
    const course = await mongoose.model('Course').findById(this.course).select('teacher department').session(this.$session() || null).lean();
    if (course) { this.set('metadata.author', course.teacher); if (!this.metadata?.department && course.department) this.set('metadata.department', course.department); }
  }
  if (!this.isNew && this.isModified('approvalStatus') && ['approved', 'rejected'].includes(this.approvalStatus)) {
    this.set('metadata.lastReviewedAt', new Date());
    const last = (this.approvalHistory || [])[this.approvalHistory.length - 1];
    if (last?.actor) this.set('metadata.lastReviewedBy', last.actor);
  }
});
require('../utils/contentVersioning')(lessonSchema,'lesson');
module.exports = mongoose.model('Lesson', lessonSchema);
