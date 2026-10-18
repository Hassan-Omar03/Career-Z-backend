// Institution staff roles (master spec 8.10) and the permissions each one starts with. The owner
// can change any staff member's permissions afterwards; only permissions the API really enforces
// can be granted. Role keys 'teacher', 'representative', 'driver' and 'warden' are also checked by
// name elsewhere (teaching, admissions desk, transport and hostel), so they keep those names.

const PERMISSIONS = {
  'application:approve': 'Accept or reject admission applications',
  'fee:manage': 'Manage fees, invoices and payments',
  'students:manage': 'Manage student records and class promotion',
  'staff:review': 'Write teacher performance reviews',
  'grading:manage': 'Manage grading and results',
  'questionbank:manage': 'Manage the question bank',
  'content:review:department': 'Review course content (department)',
  'content:review:principal': 'Approve course content (principal)',
  'communication:send': 'Send announcements to students and parents',
  'parents:manage': 'Manage parent links and family communication',
  'ops:manage': 'Operations dashboard and AI operations reports',
  'settings:manage': 'Change institution settings',
  'timetable:manage': 'Build and change class timetables',
  'placement:manage': 'Run the placement office',
  'recruitment:manage': 'Post the institute\'s jobs and manage applicants',
  'institution:health:manage': 'Manage student health records',
  'transport:manage': 'Manage transport routes and vehicles',
  'cafeteria:manage': 'Manage the cafeteria',
  'forum:moderate': 'Moderate discussion forums',
  'ai:use': 'Use the institution’s AI tools',
  'ai:manage': 'Connect and manage the institution’s AI keys'
};

const STAFF_ROLES = {
  principal: { label: 'Principal', permissions: ['application:approve', 'fee:manage', 'students:manage', 'staff:review', 'grading:manage', 'content:review:principal', 'communication:send', 'parents:manage', 'ops:manage', 'timetable:manage', 'recruitment:manage'] },
  vice_principal: { label: 'Vice Principal', permissions: ['students:manage', 'staff:review', 'grading:manage', 'content:review:department', 'communication:send', 'parents:manage', 'timetable:manage'] },
  coordinator: { label: 'Academic Coordinator', permissions: ['students:manage', 'grading:manage', 'content:review:department', 'communication:send'] },
  hod: { label: 'Head of Department', permissions: ['staff:review', 'grading:manage', 'content:review:department', 'questionbank:manage'] },
  teacher: { label: 'Teacher', permissions: [] },
  hr_manager: { label: 'HR Manager', permissions: ['staff:review', 'recruitment:manage'] },
  accountant: { label: 'Accountant', permissions: ['fee:manage'] },
  admissions_officer: { label: 'Admissions Officer', permissions: ['application:approve'] },
  representative: { label: 'Admissions Representative', permissions: [] },
  exam_controller: { label: 'Exam Controller', permissions: ['grading:manage', 'questionbank:manage'] },
  registrar: { label: 'Registrar', permissions: ['students:manage'] },
  counselor: { label: 'Student Counselor', permissions: ['parents:manage'] },
  receptionist: { label: 'Receptionist', permissions: ['communication:send'] },
  librarian: { label: 'Librarian', permissions: [] },
  warden: { label: 'Hostel Warden', permissions: [] },
  nurse: { label: 'Nurse / Medical Officer', permissions: ['institution:health:manage'] },
  transport_manager: { label: 'Transport Manager', permissions: ['transport:manage'] },
  driver: { label: 'Driver', permissions: [] },
  placement_officer: { label: 'Placement Officer', permissions: ['placement:manage'] },
  cafeteria_manager: { label: 'Cafeteria Manager', permissions: ['cafeteria:manage'] },
  it_admin: { label: 'IT Administrator', permissions: ['settings:manage', 'ai:manage', 'ai:use'] },
  lab_assistant: { label: 'Lab Assistant', permissions: [] },
  security: { label: 'Security', permissions: [] },
  staff: { label: 'Other staff', permissions: [] }
};

// Role from the request, or 422 for one we do not know.
function roleOrThrow(role, AppError) {
  if (!STAFF_ROLES[role]) throw new AppError(`Unknown staff role. Choose one of: ${Object.values(STAFF_ROLES).map((r) => r.label).join(', ')}.`, 422);
  return role;
}

// Permissions from the request (only known ones), or the role's starting set when none are given.
function permissionsFor(role, requested, AppError) {
  if (requested === undefined || requested === null) return [...STAFF_ROLES[role].permissions];
  if (!Array.isArray(requested)) throw new AppError('permissions must be a list.', 422);
  const unknown = requested.filter((p) => !PERMISSIONS[p]);
  if (unknown.length) throw new AppError(`Unknown permission: ${unknown.join(', ')}.`, 422);
  const set = new Set(requested);
  if (set.has('ai:manage')) set.add('ai:use');
  return [...set];
}

// Owner, or a staff member holding one of the given permissions.
function hasStaffPermission(institution, userId, ...permissions) {
  if (String(institution.owner) === String(userId)) return true;
  const staff = institution.staff.find((s) => String(s.user) === String(userId));
  return Boolean(staff && (staff.permissions || []).some((p) => permissions.includes(p)));
}

module.exports = { PERMISSIONS, STAFF_ROLES, roleOrThrow, permissionsFor, hasStaffPermission };
