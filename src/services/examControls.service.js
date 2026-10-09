const crypto = require('crypto');

// Per-attempt paper construction and integrity logging for online exams.

function shuffled(values) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Decides which questions (and in what order, with which option order) THIS student gets.
function buildAttemptPaper(exam) {
  const all = exam.questions.map((_, index) => index);
  let order = exam.shuffleQuestions || exam.questionsPerAttempt > 0 ? shuffled(all) : all;
  if (exam.questionsPerAttempt > 0 && exam.questionsPerAttempt < order.length) {
    // A random subset, shown in the paper's original order unless shuffling is also on.
    order = order.slice(0, exam.questionsPerAttempt);
    if (!exam.shuffleQuestions) order.sort((a, b) => a - b);
  }
  const optionOrders = order.map((qIndex) => {
    const q = exam.questions[qIndex];
    const indexes = (q.options || []).map((_, i) => i);
    return exam.shuffleOptions && q.type === 'mcq' ? shuffled(indexes) : indexes;
  });
  return { questionOrder: order, optionOrders };
}

function paperOf(exam, attempt) {
  if (attempt.questionOrder?.length) return { questionOrder: attempt.questionOrder, optionOrders: attempt.optionOrders || [] };
  return { questionOrder: exam.questions.map((_, i) => i), optionOrders: exam.questions.map((q) => (q.options || []).map((_, i) => i)) };
}

// The questions as this student sees them: no answer key, attempt order, permuted options.
function studentView(exam, attempt) {
  const { questionOrder, optionOrders } = paperOf(exam, attempt);
  return questionOrder.map((qIndex, position) => {
    const q = exam.questions[qIndex];
    const order = optionOrders[position] || (q.options || []).map((_, i) => i);
    return { text: q.text, type: q.type, marks: q.marks, options: order.map((i) => q.options[i]) };
  });
}

// Converts answers keyed by DISPLAY position/option into original question/option indexes.
function toOriginalAnswers(exam, attempt, answers) {
  const { questionOrder, optionOrders } = paperOf(exam, attempt);
  const positions = answers.map((a) => a?.questionIndex);
  if (positions.some((p) => !Number.isInteger(p) || p < 0 || p >= questionOrder.length) || new Set(positions).size !== positions.length) {
    const err = new Error('Each answer must refer to a distinct valid question.'); err.statusCode = 422; throw err;
  }
  if (answers.length !== questionOrder.length) { const err = new Error('Submit one answer entry for every question.'); err.statusCode = 422; throw err; }
  return answers.map((a) => {
    const original = questionOrder[a.questionIndex];
    const question = exam.questions[original];
    if (question.type === 'mcq') {
      const order = optionOrders[a.questionIndex] || [];
      const valid = Number.isInteger(a.selectedOption) && a.selectedOption >= 0 && a.selectedOption < order.length;
      return { questionIndex: original, selectedOption: valid ? order[a.selectedOption] : null, textAnswer: '', marksAwarded: 0 };
    }
    return { questionIndex: original, selectedOption: null, textAnswer: String(a.textAnswer || ''), marksAwarded: 0 };
  });
}

function attemptTotalMarks(exam, attempt) {
  return paperOf(exam, attempt).questionOrder.reduce((sum, i) => sum + (exam.questions[i]?.marks || 0), 0);
}

const EVENT_TYPES = new Set(['tab_hidden', 'window_blur', 'copy', 'paste', 'cut', 'context_menu', 'fullscreen_exit', 'print_screen', 'devtools', 'ip_changed', 'device_changed']);
const MAX_EVENTS = 200;

// Appends an integrity event and (re)computes the flag. Copy/paste and IP/device changes are
// serious on their own; focus loss only after the exam's threshold.
function recordEvent(exam, attempt, type, detail = '') {
  if (!EVENT_TYPES.has(type)) { const err = new Error('Unknown exam security event.'); err.statusCode = 422; throw err; }
  if (attempt.securityEvents.length < MAX_EVENTS) attempt.securityEvents.push({ type, at: new Date(), detail: String(detail).slice(0, 200) });
  const counts = attempt.securityEvents.reduce((acc, e) => ({ ...acc, [e.type]: (acc[e.type] || 0) + 1 }), {});
  const serious = (counts.paste || 0) + (counts.ip_changed || 0) + (counts.device_changed || 0) + (counts.devtools || 0);
  const focusLoss = (counts.tab_hidden || 0) + (counts.window_blur || 0) + (counts.fullscreen_exit || 0);
  attempt.flagged = serious > 0 || focusLoss >= (exam.flagThreshold || 3);
}

function clientIp(req) {
  return String(req.headers?.['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
}

module.exports = { buildAttemptPaper, studentView, toOriginalAnswers, attemptTotalMarks, recordEvent, clientIp, EVENT_TYPES };
