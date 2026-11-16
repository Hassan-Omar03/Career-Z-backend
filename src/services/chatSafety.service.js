const AppError=require('../utils/AppError');async function validate(text){if(text!==undefined&&typeof text!=='string')throw new AppError('Message must be text.',422);if((text||'').length>10000)throw new AppError('Message too long.',422);const setting=await require('../models/Setting').findOne({key:'chat_blocked_terms'});const normalized=String(text||'').normalize('NFKC').toLocaleLowerCase();if(Array.isArray(setting?.value)&&setting.value.some(term=>typeof term==='string'&&term.trim()&&normalized.includes(term.trim().normalize('NFKC').toLocaleLowerCase())))throw new AppError('This message contains language blocked by the platform communication policy.',422);}

// The first message to someone cannot carry a phone number or a link, so strangers cannot move a
// conversation off CareerZ before the other person has answered (a common start of scams).
const LINK = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|pk|net|org|io|me|co|info|xyz|online|site|link|ly|gl|app|biz)(\/\S*)?\b/i;
const DATES_AND_TIMES = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{1,2}:\d{2}(:\d{2})?\b/g;
function hasPhone(text) {
  // Dates and clock times are taken out first so 'class on 2026-11-16 10:30' is not read as a number.
  const plain = String(text).normalize('NFKC').replace(DATES_AND_TIMES, ' ');
  // Runs of digits with spaces, dashes, dots or brackets between them; 9 or more digits is a phone number.
  const runs = plain.match(/\+?\d[\d\s().-]{7,}\d/g) || [];
  return runs.some((run) => run.replace(/\D/g, '').length >= 9);
}
function firstMessageProblem(text) {
  const value = String(text || '');
  if (hasPhone(value)) return 'phone number';
  if (LINK.test(value.normalize('NFKC'))) return 'link';
  return null;
}
function assertFirstMessageSafe(text) {
  const problem = firstMessageProblem(text);
  if (problem) throw new AppError(`For your safety, the first message in a conversation cannot include a ${problem}. Send your message without it; you can share it after they reply.`, 422);
}
module.exports={validate,firstMessageProblem,assertFirstMessageSafe};
