const GradingPolicy = require('../models/GradingPolicy');

// The platform's original 4.0 scale — used whenever an institution hasn't set its own.
const DEFAULT_POLICY = Object.freeze({
  gpaScaleMax: 4,
  passingPercent: 50,
  bands: [
    { minPercent: 85, grade: 'A', points: 4 }, { minPercent: 80, grade: 'A-', points: 3.7 },
    { minPercent: 75, grade: 'B+', points: 3.3 }, { minPercent: 70, grade: 'B', points: 3 },
    { minPercent: 65, grade: 'B-', points: 2.7 }, { minPercent: 60, grade: 'C+', points: 2.3 },
    { minPercent: 55, grade: 'C', points: 2 }, { minPercent: 50, grade: 'D', points: 1.7 },
    { minPercent: 0, grade: 'F', points: 0 }
  ]
});

async function policyFor(institutionId) {
  const policy = institutionId ? await GradingPolicy.findOne({ institution: institutionId }).lean() : null;
  if (!policy?.bands?.length) return { ...DEFAULT_POLICY, isDefault: true };
  return { gpaScaleMax: policy.gpaScaleMax, passingPercent: policy.passingPercent, bands: policy.bands, isDefault: false };
}

function gradeFor(policy, percentage) {
  const band = policy.bands.find((b) => percentage >= b.minPercent) || policy.bands[policy.bands.length - 1];
  return { grade: band.grade, points: band.points, passed: percentage >= policy.passingPercent };
}

// Throws a readable error for anything that would make grading ambiguous or wrong.
function validatePolicy({ gpaScaleMax, passingPercent, bands }) {
  const scale = Number(gpaScaleMax);
  if (![4, 5, 10].includes(scale)) throw new Error('GPA scale must be 4, 5 or 10.');
  const pass = Number(passingPercent);
  if (!Number.isFinite(pass) || pass < 0 || pass > 100) throw new Error('Passing percentage must be between 0 and 100.');
  if (!Array.isArray(bands) || bands.length < 2 || bands.length > 20) throw new Error('Add between 2 and 20 grade bands.');
  const clean = bands.map((b) => ({ minPercent: Number(b.minPercent), grade: String(b.grade || '').trim(), points: Number(b.points) }))
    .sort((a, b) => b.minPercent - a.minPercent);
  for (const b of clean) {
    if (!b.grade || b.grade.length > 8) throw new Error('Every band needs a grade label of up to 8 characters.');
    if (!Number.isFinite(b.minPercent) || b.minPercent < 0 || b.minPercent > 100) throw new Error(`Band ${b.grade}: minimum % must be 0-100.`);
    if (!Number.isFinite(b.points) || b.points < 0 || b.points > scale) throw new Error(`Band ${b.grade}: points must be between 0 and ${scale}.`);
  }
  if (new Set(clean.map((b) => b.minPercent)).size !== clean.length) throw new Error('Two bands cannot start at the same percentage.');
  if (new Set(clean.map((b) => b.grade.toUpperCase())).size !== clean.length) throw new Error('Grade labels must be unique.');
  if (clean[clean.length - 1].minPercent !== 0) throw new Error('The lowest band must start at 0% so every score gets a grade.');
  for (let i = 1; i < clean.length; i += 1) {
    if (clean[i].points > clean[i - 1].points) throw new Error('A lower band cannot be worth more points than a higher band.');
  }
  return { gpaScaleMax: scale, passingPercent: pass, bands: clean };
}

module.exports = { DEFAULT_POLICY, policyFor, gradeFor, validatePolicy };
