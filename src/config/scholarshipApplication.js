// What a donor can ask for when posting a scholarship, and the application form every applicant
// fills (personal, education, family, and the reason for applying).

const DOCUMENTS = [
  { key: 'cnic', label: 'CNIC / B-Form' },
  { key: 'photo', label: 'Passport-size photo' },
  { key: 'matric', label: 'Matric / O-Level certificate' },
  { key: 'intermediate', label: 'Intermediate / A-Level certificate' },
  { key: 'bachelor', label: 'Bachelor degree / transcript' },
  { key: 'latest_result', label: 'Latest result card / transcript' },
  { key: 'enrollment_proof', label: 'Admission letter or enrollment proof' },
  { key: 'fee_voucher', label: 'Current fee voucher / challan' },
  { key: 'income_proof', label: 'Parent / guardian income proof (salary slip or certificate)' },
  { key: 'utility_bill', label: 'Recent utility bill' },
  { key: 'domicile', label: 'Domicile' },
  { key: 'character_certificate', label: 'Character certificate' },
  { key: 'recommendation_letter', label: 'Recommendation letter' }
];
const DOCUMENT_KEYS = DOCUMENTS.map((d) => d.key);

const FIELDS = [
  { key: 'fullName', label: 'Full name', required: true, group: 'Personal' },
  { key: 'fatherName', label: "Father's / guardian's name", required: true, group: 'Personal' },
  { key: 'cnic', label: 'CNIC / B-Form number', required: true, group: 'Personal', pattern: 'cnic' },
  { key: 'dateOfBirth', label: 'Date of birth', required: true, group: 'Personal', type: 'date' },
  { key: 'gender', label: 'Gender', required: true, group: 'Personal', type: 'select', options: ['male', 'female', 'other'] },
  { key: 'phone', label: 'Phone number', required: true, group: 'Contact', pattern: 'phone' },
  { key: 'email', label: 'Email', required: true, group: 'Contact', pattern: 'email' },
  { key: 'address', label: 'Home address', required: true, group: 'Contact', type: 'textarea' },
  { key: 'city', label: 'City', required: true, group: 'Contact' },
  { key: 'province', label: 'Province / state', required: false, group: 'Contact' },
  { key: 'country', label: 'Country', required: true, group: 'Contact' },
  { key: 'currentInstitution', label: 'Current institute / university', required: true, group: 'Education' },
  { key: 'currentDegree', label: 'Current degree / program (e.g. BS Computer Science)', required: true, group: 'Education' },
  { key: 'currentYear', label: 'Current year / semester', required: false, group: 'Education' },
  { key: 'lastDegree', label: 'Last completed degree / class', required: true, group: 'Education' },
  { key: 'lastResult', label: 'Last result (marks % or CGPA)', required: true, group: 'Education' },
  { key: 'designation', label: 'Designation / job (if working)', required: false, group: 'Education' },
  { key: 'fatherOccupation', label: "Father's / guardian's occupation", required: true, group: 'Family' },
  { key: 'monthlyFamilyIncome', label: 'Monthly family income (PKR)', required: true, group: 'Family', pattern: 'number' },
  { key: 'dependents', label: 'Family members depending on this income', required: false, group: 'Family', pattern: 'number' }
];

const REASON_MIN = 50;

module.exports = { DOCUMENTS, DOCUMENT_KEYS, FIELDS, REASON_MIN };
