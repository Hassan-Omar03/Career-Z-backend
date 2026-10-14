// Plagiarism check for one assignment (master spec 9.10): compares every pair of written
// submissions in the class and flags pairs that share long runs of the same wording. It does not
// search the internet or read attached files; the teacher sees that scope on screen.

const SHINGLE = 5; // five-word runs: common phrases rarely match by chance at this length
const MIN_WORDS = 30;

function words(text) {
  return String(text || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

function shingles(list) {
  const out = new Set();
  for (let i = 0; i + SHINGLE <= list.length; i++) out.add(list.slice(i, i + SHINGLE).join(' '));
  return out;
}

// Share of the shorter text found in the other, so copying a paragraph into a longer answer still shows.
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) shared++;
  return shared / small.size;
}

// submissions: [{ id, studentName, text }] → pairs at or above `threshold` (0-1), highest first.
function comparePairs(submissions, threshold = 0.4) {
  const ready = submissions.map((s) => ({ ...s, words: words(s.text) })).filter((s) => s.words.length >= MIN_WORDS).map((s) => ({ ...s, set: shingles(s.words) }));
  const pairs = [];
  for (let i = 0; i < ready.length; i++) {
    for (let j = i + 1; j < ready.length; j++) {
      const score = overlap(ready[i].set, ready[j].set);
      if (score >= threshold) {
        pairs.push({
          a: { submission: ready[i].id, student: ready[i].studentName },
          b: { submission: ready[j].id, student: ready[j].studentName },
          similarityPercent: Math.round(score * 100),
          level: score >= 0.8 ? 'high' : score >= 0.6 ? 'medium' : 'low'
        });
      }
    }
  }
  return {
    checked: ready.length,
    skippedShort: submissions.length - ready.length,
    pairs: pairs.sort((x, y) => y.similarityPercent - x.similarityPercent),
    scope: `Compares written answers of at least ${MIN_WORDS} words within this assignment only. Attached files and internet sources are not checked.`
  };
}

module.exports = { comparePairs, words };
