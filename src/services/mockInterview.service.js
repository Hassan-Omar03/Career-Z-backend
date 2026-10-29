const mongoose = require('mongoose');
const MockInterview = require('../models/MockInterview');
const AppError = require('../utils/AppError');

// AI Mock Interview (master: AI interview practice with answer analysis and confidence level).
// The AI writes the questions and scores each answer; the confidence level blends the AI's view
// with plain signals read from the answer itself (hedging and filler words, length, time taken)
// so it is explainable. Uses the candidate's own AI key (AI Settings).

const fail = (message, status = 422) => new AppError(message, status);
const ai = () => require('./ai.service');
const clip = (s, n) => String(s || '').trim().slice(0, n);
const json = (text) => { const s = String(text || ''); try { return JSON.parse(s.slice(Math.min(...['{', '['].map((c) => (s.indexOf(c) < 0 ? Infinity : s.indexOf(c)))), Math.max(s.lastIndexOf('}'), s.lastIndexOf(']')) + 1)); } catch { throw fail('The AI answer could not be read. Try again.', 502); } };
const HEDGES = /\b(maybe|perhaps|i think|i guess|not sure|probably|kind of|sort of|i don'?t know|might be|hopefully)\b/gi;
const FILLERS = /\b(um+|uh+|erm|like,|you know|basically|actually)\b/gi;

// Plain signals from the answer (0-100, higher = more confident) with the reasons shown to the user.
function signals(answer, seconds) {
  const words = answer.split(/\s+/).filter(Boolean).length;
  const hedges = (answer.match(HEDGES) || []).length;
  const fillers = (answer.match(FILLERS) || []).length;
  let score = 70;
  const why = [];
  if (words < 15) { score -= 25; why.push('Very short answer'); } else if (words < 40) { score -= 10; why.push('Short answer: add an example'); } else if (words > 60) { score += 10; why.push('Detailed answer'); }
  if (hedges) { score -= Math.min(30, hedges * 8); why.push(`${hedges} unsure phrase${hedges > 1 ? 's' : ''} ("maybe", "I think"…)`); }
  if (fillers) { score -= Math.min(20, fillers * 5); why.push(`${fillers} filler word${fillers > 1 ? 's' : ''}`); }
  if (/\b(i (led|built|managed|solved|delivered|improved|taught|designed|achieved|increased|reduced))\b/i.test(answer)) { score += 10; why.push('Clear "I did" statements'); }
  if (/\d/.test(answer)) { score += 5; why.push('Uses numbers or facts'); }
  if (seconds != null && seconds > 0 && words / Math.max(seconds / 60, 0.1) < 25 && seconds > 90) { score -= 5; why.push('Took long to answer'); }
  return { score: Math.max(0, Math.min(100, score)), why };
}
const levelOf = (n) => (n >= 70 ? 'high' : n >= 45 ? 'medium' : 'low');

async function start(user, body = {}) {
  const role = clip(body.role, 120);
  if (role.length < 2) throw fail('Write the job role you are practising for, for example "Primary school teacher".');
  const level = ['fresher', 'junior', 'mid', 'senior'].includes(body.level) ? body.level : 'junior';
  const focus = ['mixed', 'technical', 'behavioural', 'hr'].includes(body.focus) ? body.focus : 'mixed';
  const count = Math.min(Math.max(Number(body.count) || 5, 3), 10);
  let job = null;
  if (body.job && mongoose.isValidObjectId(body.job)) job = await require('../models/Job').findById(body.job).select('title company description skills').lean();
  const text = await ai().generate(user._id,
    'You are a strict but fair job interviewer on a Pakistani careers platform. Write realistic interview questions for the role. One question each, no numbering, no answers. Reply ONLY with JSON: {"questions":[{"question":"","kind":"technical|behavioural|hr|situational"}]}',
    `Role: ${role}\nExperience level: ${level}\nFocus: ${focus}\nNumber of questions: ${count}${job ? `\nReal job: ${job.title} at ${job.company}\nSkills: ${(job.skills || []).join(', ')}\nDescription: ${clip(job.description, 1200)}` : ''}`);
  const parsed = json(text);
  const list = (Array.isArray(parsed) ? parsed : parsed.questions || []).map((q) => (typeof q === 'string' ? { question: q } : q)).filter((q) => clip(q.question, 500).length > 5).slice(0, count);
  if (list.length < 2) throw fail('The AI did not return questions. Try again.', 502);
  return MockInterview.create({ user: user._id, role, level, focus, job: job?._id || null, questions: list.map((q) => ({ question: clip(q.question, 500), kind: ['technical', 'behavioural', 'hr', 'situational'].includes(q.kind) ? q.kind : 'general' })) });
}

async function own(user, id) {
  if (!mongoose.isValidObjectId(id)) throw fail('Practice interview not found.', 404);
  const s = await MockInterview.findOne({ _id: id, user: user._id });
  if (!s) throw fail('Practice interview not found.', 404);
  return s;
}

async function answer(user, id, body = {}) {
  const s = await own(user, id);
  if (s.status !== 'in_progress') throw fail('This practice interview is finished. Start a new one.', 409);
  const i = Number(body.index);
  const q = s.questions[i];
  if (!q) throw fail('Question not found.', 404);
  const text = clip(body.answer, 4000);
  if (text.length < 3) throw fail('Write or speak your answer first.');
  const seconds = Number.isFinite(Number(body.seconds)) ? Math.max(0, Math.round(Number(body.seconds))) : null;
  const sig = signals(text, seconds);
  const res = json(await ai().generate(user._id,
    'You are an interview coach. Score the candidate\'s answer honestly for the role and level. Judge content, structure (situation, action, result), relevance and how confident and clear it sounds. Plain text inside JSON strings. Reply ONLY with JSON: {"score":0-10,"feedback":"2-3 sentences: what was good and what was missing","betterAnswer":"a short model answer","confidence":"low|medium|high","confidenceReason":"one short reason"}',
    `Role: ${s.role} (${s.level})\nQuestion (${q.kind}): ${q.question}\nCandidate answer${body.spoken ? ' (spoken, transcribed)' : ''}: ${text}`));
  const aiScore = Math.max(0, Math.min(10, Math.round(Number(res.score) || 0)));
  const aiConf = { low: 30, medium: 60, high: 85 }[res.confidence] ?? 55;
  const conf = Math.round(aiConf * 0.6 + sig.score * 0.4);
  Object.assign(q, {
    answer: text, spoken: Boolean(body.spoken), seconds, score: aiScore,
    feedback: clip(res.feedback, 1200), betterAnswer: clip(res.betterAnswer, 1500),
    confidence: { level: levelOf(conf), score: conf, signals: [clip(res.confidenceReason, 200), ...sig.why].filter(Boolean).slice(0, 6) },
    answeredAt: new Date()
  });
  s.markModified('questions');
  await s.save();
  return s;
}

async function finish(user, id) {
  const s = await own(user, id);
  if (s.status === 'completed') return s;
  const done = s.questions.filter((q) => q.score != null);
  if (!done.length) throw fail('Answer at least one question before you finish.');
  const overall = Math.round((done.reduce((a, q) => a + q.score, 0) / done.length) * 10);
  const conf = Math.round(done.reduce((a, q) => a + (q.confidence?.score || 0), 0) / done.length);
  const res = json(await ai().generate(user._id,
    'You are an interview coach writing the end-of-interview report. Be specific to the answers given. Plain text inside JSON strings. Reply ONLY with JSON: {"verdict":"2 sentences: would this candidate likely pass, and why","strengths":["",""],"improvements":["",""],"nextSteps":["",""]}',
    `Role: ${s.role} (${s.level})\nOverall score: ${overall}/100\nConfidence: ${levelOf(conf)} (${conf}/100)\n${done.map((q, n) => `Q${n + 1}: ${q.question}\nA: ${clip(q.answer, 600)}\nScore: ${q.score}/10`).join('\n\n')}`));
  const list = (v) => (Array.isArray(v) ? v.map((x) => clip(x, 300)).filter(Boolean).slice(0, 5) : []);
  s.summary = { overallScore: overall, confidence: levelOf(conf), confidenceScore: conf, verdict: clip(res.verdict, 800), strengths: list(res.strengths), improvements: list(res.improvements), nextSteps: list(res.nextSteps) };
  s.status = 'completed';
  s.completedAt = new Date();
  await s.save();
  return s;
}

async function mine(user) {
  return MockInterview.find({ user: user._id }).select('role level focus status summary.overallScore summary.confidence createdAt completedAt questions.score').sort({ createdAt: -1 }).limit(50).lean();
}
async function get(user, id) { return own(user, id); }
async function remove(user, id) { const s = await own(user, id); await s.deleteOne(); return { deleted: true }; }

module.exports = { start, answer, finish, mine, get, remove, signals };
