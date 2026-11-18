// Audit points 14 and 15 (Master 6.2 Category B): a new institute founder without a building or a
// government registration can sign up, and an online institute does not have to give a physical address.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../src/config/accountVerification');
const { evaluateProfile } = require('../src/services/accountVerification.service');

const base = {
  instituteName: 'Bright Minds Online', instituteEmail: 'hello@brightminds.example', officialContactNumber: '03001234567',
  country: 'Pakistan', province: 'KPK', city: 'Peshawar', representativeName: 'Sana Ali', representativeCnic: '1730112345671',
  description: 'Online coaching for matric and FSc students.'
};
const missingOf = (role, subtype, fields) => evaluateProfile(role, subtype, { fields, sensitive: { representativeCnic: { encrypted: 'x' } } }).missing.map((f) => f.key || f);

test('the founder kind is accepted for an institute account', () => {
  assert.deepEqual(cfg.SUBTYPES.institution_owner, ['registered', 'founder']);
});

test('a founder gives CNIC, degree and experience instead of the registration certificate', () => {
  const docs = cfg.documentRequirements('institution_owner', 'founder');
  const types = docs.flatMap((g) => (g.anyOf || []).flat(Infinity)).join(',');
  assert.ok(!/institute_registration_certificate|registration_proof/.test(types), types);
  for (const t of ['representative_cnic', 'degree_certificate', 'experience_proof']) assert.ok(types.includes(t), t);
  const registered = cfg.documentRequirements('institution_owner', 'registered').flatMap((g) => (g.anyOf || []).flat(Infinity)).join(',');
  assert.ok(registered.includes('institute_registration_certificate'), 'a registered institute still needs its certificate');
});

test('a founder needs no registration number or address but must accept the founder agreement', () => {
  const fields = { ...base, instituteType: 'academy', highestQualification: 'MSc Physics', experienceYears: '6' };
  const missing = missingOf('institution_owner', 'founder', fields);
  assert.ok(!missing.includes('registrationNumber') && !missing.includes('address') && !missing.includes('location'), String(missing));
  assert.ok(missing.includes('founderAgreement'));
  assert.deepEqual(missingOf('institution_owner', 'founder', { ...fields, founderAgreement: 'i_accept_the_agreement' }), []);
});

test('an online institute does not need a physical address; a campus institute does', () => {
  const fields = { ...base, instituteType: 'online_institute', registrationNumber: 'REG-1' };
  const online = missingOf('institution_owner', 'registered', fields);
  assert.ok(!online.includes('address') && !online.includes('location'), String(online));
  const campus = missingOf('institution_owner', 'registered', { ...fields, instituteType: 'school' });
  assert.ok(campus.includes('address') && campus.includes('location'));
});
