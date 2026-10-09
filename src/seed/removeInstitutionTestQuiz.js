require('dotenv').config();
const mongoose=require('mongoose');
const connectDB=require('../config/db');
const Activity=require('../models/LearningActivity');
const Course=require('../models/Course');
const Institution=require('../models/Institution');
const Lesson=require('../models/Lesson');
async function run(){
 await connectDB();
 const id='6ac8e3d1a4e314747e425871';
 const row=await Activity.findById(id);
 if(!row){console.log('Target test quiz already absent.');return;}
 const course=await Course.findById(row.course),institution=course&&await Institution.findById(course.institution),lesson=await Lesson.findById(row.lesson);
 if(row.title!=='Computer Basics Quiz'||row.type!=='quiz'||String(row.course)!=='6ab3c85d985008ecc065ccff'||institution?.slug!=='gcuf'||lesson?.title!=='Computer kya hai?'||row.content?.questions?.[0]?.question!=='Input device konsa hai?')throw new Error('Target record did not match the requested test quiz; nothing deleted.');
 await require('../services/learningBackup.service').capture(row.course);
 const result=await Activity.deleteOne({_id:id,course:row.course,lesson:row.lesson,title:row.title,updatedAt:row.updatedAt});
 if(result.deletedCount!==1)throw new Error('Quiz changed during deletion; re-inspect before retrying.');
 await require('../services/learningBackup.service').capture(row.course);
 console.log(JSON.stringify({deleted:result.deletedCount,title:row.title,remaining:await Activity.countDocuments({_id:id})}));
}
run().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>mongoose.disconnect());
