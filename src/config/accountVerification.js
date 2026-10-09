// What every account type must submit for verification and fill in its profile.
// Spec account types → platform roles.
const ACCOUNT_TYPES = {
  student: { role: 'student', label: 'Student' },
  parent: { role: 'parent', label: 'Parent' },
  teacher: { role: 'teacher', label: 'Teacher' },
  institute: { role: 'institution_owner', label: 'Institute' },
  agent: { role: 'education_agent', label: 'Agent' },
  donor: { role: 'donor', label: 'Donor' },
  marketplace: { role: 'marketplace_seller', label: 'Marketplace' }
};
const VERIFIED_ROLES = Object.values(ACCOUNT_TYPES).map((t) => t.role).concat('academy_owner');
const ROLE_LABEL = { ...Object.fromEntries(Object.values(ACCOUNT_TYPES).map((t) => [t.role, t.label])), academy_owner: 'Institute' };
const roleFor = (accountType) => ACCOUNT_TYPES[accountType]?.role || null;

const DOCUMENT_TYPES = {
  cnic_front: 'CNIC – front', cnic_back: 'CNIC – back', b_form: 'B-Form', other_identity: 'Other identity document',
  profile_picture: 'Profile picture', degree_certificate: 'Degree certificate', academic_transcript: 'Academic transcript / marksheet',
  institute_registration_certificate: 'Institute registration certificate', registration_proof: 'Business / institute registration proof',
  representative_cnic: 'Owner / authorized representative CNIC', institute_logo: 'Institute logo / profile picture', other_legal: 'Other legal registration document',
  agency_registration_certificate: 'Agency registration certificate', agency_authorization: 'Agency authorization document',
  organization_registration_certificate: 'Organization registration certificate', representative_identity: 'Authorized representative identity document',
  business_registration_certificate: 'Business registration certificate', owner_identity: 'Business owner / representative identity document'
};
const IMAGE_ONLY = new Set(['profile_picture', 'institute_logo']);

// Identity: CNIC front+back, or the alternative listed for that role.
const identity = (alternative) => ({ anyOf: [['cnic_front', 'cnic_back'], [alternative]], label: `CNIC (front and back) or ${DOCUMENT_TYPES[alternative]}` });

// Document requirements per role. `subtype` (organization/business/agency) adds conditional ones.
function documentRequirements(role, subtype = '') {
  const groups = [];
  const add = (types, label, mandatory = true) => groups.push({ anyOf: [types], label: label || types.map((t) => DOCUMENT_TYPES[t]).join(' + '), mandatory });
  switch (role) {
    case 'student': groups.push({ ...identity('b_form'), mandatory: true }); add(['profile_picture']); break;
    case 'parent': groups.push({ ...identity('other_identity'), mandatory: true }); add(['profile_picture']); break;
    case 'teacher': groups.push({ ...identity('other_identity'), mandatory: true }); add(['profile_picture']); add(['degree_certificate']); add(['academic_transcript']); break;
    case 'institution_owner': case 'academy_owner':
      add(['institute_registration_certificate']); add(['registration_proof']); add(['representative_cnic']); add(['institute_logo']); add(['other_legal'], null, false); break;
    case 'education_agent':
      groups.push({ ...identity('other_identity'), mandatory: true }); add(['profile_picture']);
      add(['agency_registration_certificate'], null, subtype === 'agency'); add(['agency_authorization'], null, false); break;
    case 'donor':
      groups.push({ ...identity('other_identity'), mandatory: true }); add(['profile_picture']);
      if (subtype === 'organization') { add(['organization_registration_certificate']); add(['representative_identity']); }
      break;
    case 'marketplace_seller':
      groups.push({ ...identity('other_identity'), mandatory: true }); add(['profile_picture']);
      if (subtype === 'business') { add(['business_registration_certificate']); add(['owner_identity']); }
      break;
    default: break;
  }
  return groups;
}
const allowedDocumentTypes = (role, subtype) => new Set(documentRequirements(role, subtype).flatMap((g) => g.anyOf.flat()));

// Field catalogue. `when` makes a field required only for some subtypes.
const F = (key, label, opts = {}) => ({ key, label, required: true, ...opts });
const PERSON = [F('firstName', 'First name'), F('lastName', 'Last name / surname'), F('fullName', 'Full name'), F('gender', 'Gender', { type: 'select', options: ['male', 'female', 'other'] }), F('dateOfBirth', 'Date of birth', { type: 'date' })];
const ADDRESS = [F('address', 'Complete residential address', { type: 'textarea' }), F('city', 'City'), F('province', 'Province'), F('country', 'Country')];

function profileFields(role, subtype = '') {
  const individual = !(role === 'donor' && subtype === 'organization') && !(role === 'marketplace_seller' && subtype === 'business');
  switch (role) {
    case 'student': return [...PERSON, F('fatherName', "Father's name"), F('cnicOrBForm', 'CNIC / B-Form number', { sensitive: true, pattern: 'cnic' }), ...ADDRESS, F('parentContactNumber', 'Parent / guardian contact number', { pattern: 'phone' }), F('contactNumber', 'Personal contact number', { required: false, pattern: 'phone' })];
    case 'parent': return [...PERSON, F('cnicNumber', 'CNIC number', { sensitive: true, pattern: 'cnic' }), F('contactNumber', 'Contact number', { pattern: 'phone' }), ...ADDRESS];
    case 'teacher': return [...PERSON, F('fatherName', "Father's name"), F('cnicNumber', 'CNIC number', { sensitive: true, pattern: 'cnic' }), F('contactNumber', 'Contact number', { pattern: 'phone' }), F('email', 'Email address', { pattern: 'email' }), ...ADDRESS,
      F('highestQualification', 'Highest qualification'), F('degreeTitle', 'Degree title'), F('specialization', 'Specialization / subject'), F('university', 'University / institute name'), F('graduationYear', 'Graduation year', { pattern: 'year' }), F('teachingExperience', 'Teaching experience (years)', { required: false })];
    case 'institution_owner': case 'academy_owner': return [F('instituteName', 'Institute name'), F('instituteType', 'Institute type', { type: 'select', options: ['school', 'college', 'university', 'academy', 'training_center', 'other'] }), F('registrationNumber', 'Institute registration number'),
      F('instituteEmail', 'Institute email address', { pattern: 'email' }), F('officialContactNumber', 'Official contact number', { pattern: 'phone' }), F('alternateContactNumber', 'Alternate contact number', { required: false, pattern: 'phone' }),
      F('address', 'Complete institute address', { type: 'textarea' }), F('city', 'City'), F('province', 'Province'), F('country', 'Country'), F('location', 'Institute location (map link or coordinates)'),
      F('representativeName', 'Authorized representative name'), F('representativeCnic', 'Authorized representative CNIC', { sensitive: true, pattern: 'cnic' }), F('description', 'Institute description', { type: 'textarea' }), F('website', 'Website', { required: false, pattern: 'url' })];
    case 'education_agent': return [F('firstName', 'First name'), F('lastName', 'Last name'), F('fullName', 'Full name'), F('gender', 'Gender', { type: 'select', options: ['male', 'female', 'other'] }), F('dateOfBirth', 'Date of birth', { type: 'date' }),
      F('cnicNumber', 'CNIC number', { sensitive: true, pattern: 'cnic' }), F('contactNumber', 'Contact number', { pattern: 'phone' }), F('email', 'Email address', { pattern: 'email' }), F('agencyName', 'Agency name'),
      F('agencyRegistrationNumber', 'Agency registration number', { required: subtype === 'agency' }), F('agencyAddress', 'Agency address', { type: 'textarea' }), F('address', 'Personal residential address', { type: 'textarea' }), F('city', 'City'), F('province', 'Province'), F('country', 'Country')];
    case 'donor': return [F('firstName', 'First name'), F('lastName', 'Last name'), F('fullName', 'Full name'), F('gender', 'Gender', { type: 'select', options: ['male', 'female', 'other'], required: individual }), F('dateOfBirth', 'Date of birth', { type: 'date', required: individual }),
      F('cnicNumber', 'CNIC number', { sensitive: true, pattern: 'cnic', required: individual }), F('contactNumber', 'Contact number', { pattern: 'phone' }), F('email', 'Email address', { pattern: 'email' }), F('address', 'Complete address', { type: 'textarea' }), F('city', 'City'), F('province', 'Province'), F('country', 'Country'),
      F('organizationName', 'Organization name', { required: !individual }), F('organizationRegistrationNumber', 'Organization registration number', { required: !individual })];
    case 'marketplace_seller': return [F('firstName', 'First name'), F('lastName', 'Last name'), F('fullName', 'Full name'), F('gender', 'Gender', { type: 'select', options: ['male', 'female', 'other'], required: individual }), F('dateOfBirth', 'Date of birth', { type: 'date', required: individual }),
      F('cnicNumber', 'CNIC number', { sensitive: true, pattern: 'cnic', required: individual }), F('contactNumber', 'Contact number', { pattern: 'phone' }), F('email', 'Email address', { pattern: 'email' }),
      F('businessName', 'Business / shop name', { required: !individual }), F('businessRegistrationNumber', 'Business registration number', { required: !individual }), F('address', 'Complete address', { type: 'textarea' }), F('city', 'City'), F('province', 'Province'), F('country', 'Country'), F('businessDescription', 'Business description', { type: 'textarea', required: !individual })];
    default: return [];
  }
}

const SUBTYPES = {
  donor: ['individual', 'organization'],
  marketplace_seller: ['individual', 'business'],
  education_agent: ['individual', 'agency']
};

const STATUSES = ['awaiting_documents', 'pending_approval', 'under_review', 'approved', 'rejected', 'resubmission_required', 'suspended'];

module.exports = { ACCOUNT_TYPES, VERIFIED_ROLES, ROLE_LABEL, roleFor, DOCUMENT_TYPES, IMAGE_ONLY, documentRequirements, allowedDocumentTypes, profileFields, SUBTYPES, STATUSES };
