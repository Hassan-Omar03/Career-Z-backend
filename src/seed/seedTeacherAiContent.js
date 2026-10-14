// Fills every teacher class with real AI Teacher Assistant content (notes, quiz, lesson plan,
// assignment, question paper, rubric and a slide deck) and publishes it through the same
// "Review & Share with Students" path the dashboard uses, so enrolled students see it as lessons.
// Uses the same prompts and class context as /api/ai/generate. Needs AI_SEED_OPENAI_KEY in .env.
// Safe to re-run: content already published to a class is skipped.
//
//   npm run seed:teacher-ai              all classes
//   npm run seed:teacher-ai -- --dry     list what would be generated, no AI calls or writes
require('dotenv').config();

// In-app notifications only: a seed run must not email every student once per lesson.
const notifications = require('../services/notification.service');
const realNotify = notifications.notify;
notifications.notify = (user, message, options = {}) => realNotify(user, message, { ...options, email: false });

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Course = require('../models/Course');
const Lesson = require('../models/Lesson');
const User = require('../models/User');
const { FEATURE_PROMPTS, classContext } = require('../controllers/ai.controller');
const { shareAiResource } = require('../controllers/course.controller');

const MODEL = 'gpt-4o-mini';
const DRY = process.argv.includes('--dry');

const TOOLS = [
  ['teacher_notes', 'Notes', (topic) => `Class notes on ${topic}.`],
  ['teacher_quiz', 'Quiz', (topic) => `Quiz on ${topic}.`],
  ['teacher_lesson_plan', 'Lesson Plan', (topic) => `A 60-minute lesson plan on ${topic}.`],
  ['teacher_assignment', 'Assignment', (topic) => `A take-home assignment on ${topic} with clear marking criteria, 20 marks.`],
  ['teacher_paper', 'Question Paper', (topic) => `A 50-mark question paper on ${topic}: MCQs, short questions and one long question.`],
  ['teacher_rubric', 'Rubric', (topic) => `An assessment rubric for a practical task on ${topic}.`],
  ['teacher_slides', 'Slides', (topic) => `6 slides introducing ${topic}. No images.`]
];

// One concrete topic per subject so the content reads like a real week of teaching.
const TOPICS = [
  [/programming/i, 'loops and arrays in C++'],
  [/discrete/i, 'propositional logic and truth tables'],
  [/digital logic/i, 'logic gates and Boolean algebra'],
  [/computing/i, 'computer hardware, software and the operating system'],
  [/.*/, 'the core concepts of this course']
];

// Retries only network failures; an error answer from OpenAI (bad key, quota) stops the run.
async function openAi(apiKey, system, user, attempt = 1) {
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
  });
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return openAi(apiKey, system, user, attempt + 1);
  }
  const payload = await res.json();
  if (!res.ok) throw new Error(payload?.error?.message || `OpenAI request failed (${res.status})`);
  const text = payload.choices?.[0]?.message?.content || '';
  if (!text.trim()) throw new Error('OpenAI returned an empty answer.');
  return text;
}

// Same delimited format the dashboard's parseSlides() reads.
function parseSlides(raw) {
  const color = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v) ? v : fallback);
  return raw.split('---SLIDE---').map((part) => part.trim()).filter(Boolean).map((part) => {
    const lines = part.split('\n').map((l) => l.trim()).filter(Boolean);
    const field = (name) => lines.find((l) => new RegExp(`^${name}:`, 'i').test(l))?.replace(new RegExp(`^${name}:\\s*`, 'i'), '') || '';
    return {
      title: field('TITLE') || 'Untitled Slide',
      bullets: lines.filter((l) => l.startsWith('-')).map((l) => l.replace(/^-\s*/, '')),
      background: color(field('BACKGROUND'), '#fff8e7'),
      accent: color(field('ACCENT'), '#d97706'),
      text: color(field('TEXT'), '#1f2937'),
      imageUrl: ''
    };
  }).filter((s) => s.title !== 'Untitled Slide' || s.bullets.length > 0);
}

function share(teacher, courseId, body) {
  return new Promise((resolve, reject) => {
    const res = { status() { return this; }, json(value) { resolve(value.data); return this; } };
    shareAiResource({ user: teacher, params: { id: courseId }, body }, res, reject);
  });
}

async function run() {
  const apiKey = process.env.AI_SEED_OPENAI_KEY;
  if (!apiKey && !DRY) throw new Error('Set AI_SEED_OPENAI_KEY in .env first.');
  await connectDB();

  const courses = await Course.find({ teacher: { $ne: null } }).select('title subject teacher').sort({ title: 1 });
  let made = 0, skipped = 0, notified = 0;
  for (const course of courses) {
    const teacher = await User.findById(course.teacher).select('fullName email');
    if (!teacher) continue;
    const topic = TOPICS.find(([re]) => re.test(`${course.subject} ${course.title}`))[1];
    console.log(`\n${course.title} — ${teacher.fullName} — topic: ${topic}`);
    const context = await classContext(course._id, teacher._id);

    for (const [feature, label, request] of TOOLS) {
      const title = `${label}: ${topic.replace(/^\w/, (c) => c.toUpperCase())}`;
      if (await Lesson.exists({ course: course._id, title })) { skipped++; console.log(`  skip  ${title} (already published)`); continue; }
      if (DRY) { console.log(`  would generate ${title}`); continue; }

      const text = await openAi(apiKey, FEATURE_PROMPTS[feature], context + request(topic));
      const body = feature === 'teacher_slides' ? { title, deck: { slides: parseSlides(text) } } : { title, content: text };
      if (body.deck && !body.deck.slides.length) throw new Error(`No slides could be read for ${course.title}.`);
      const result = await share(teacher, course._id, body);
      made++; notified += result.notifiedCount;
      console.log(`  done  ${title}${body.deck ? ` (${body.deck.slides.length} slides)` : ''} → ${result.notifiedCount} student(s) notified`);
    }
  }
  console.log(`\n${DRY ? 'Dry run. ' : ''}Published ${made}, skipped ${skipped}, ${notified} in-app notifications sent.`);
}

run()
  .catch((error) => { console.error('Seed failed:', error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
