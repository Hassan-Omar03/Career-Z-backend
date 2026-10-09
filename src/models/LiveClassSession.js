const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  joinedAt: { type: Date, required: true },
  leftAt: { type: Date, default: null },
  durationMinutes: { type: Number, default: 0 },
  attendanceStatus: { type: String, enum: ['present', 'late'], default: 'present' }
}, { _id: false });

const liveClassSessionSchema = new mongoose.Schema({
  mode: { type: String, enum: ['online','physical','hybrid'], default: 'online' },
  physicalAttendance: [{ student: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, status: { type: String, enum: ['present','late','absent','excused'] } }],
  classroomPolicy:{chatAllowed:{type:Boolean,default:true},microphoneAllowed:{type:Boolean,default:true},cameraRequired:{type:Boolean,default:false},screenShareAllowed:{type:Boolean,default:false},fileSharingAllowed:{type:Boolean,default:true}},
  recordingUrl: String,
  recording: {type:Boolean,default:false},
  breakoutGroups: [{name:String,students:[{type:mongoose.Schema.Types.ObjectId,ref:'User'}]}],
  board: [{type:mongoose.Schema.Types.Mixed}],
  sharedFiles: [{name:String,url:String}],
  classroomQuiz: {type:mongoose.Schema.Types.Mixed},
  institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
  classSection: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSection', required: true },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  timetableEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'TimetableEntry', default: null },
  title: { type: String, required: true, trim: true },
  scheduledStart: { type: Date, required: true, index: true },
  scheduledEnd: { type: Date, required: true },
  provider: { type: String, enum: ['careerz_jitsi', 'external'], default: 'careerz_jitsi' },
  roomName: { type: String, required: true, unique: true },
  externalMeetingUrl: { type: String, default: '' },
  status: { type: String, enum: ['scheduled', 'live', 'ended', 'cancelled'], default: 'scheduled', index: true },
  startedAt: { type: Date, default: null },
  endedAt: { type: Date, default: null },
  participants: { type: [participantSchema], default: [] },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

module.exports = mongoose.model('LiveClassSession', liveClassSessionSchema);
