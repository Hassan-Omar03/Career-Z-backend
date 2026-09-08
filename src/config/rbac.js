// Central RBAC definition: roles and their default permissions.
// Super Admin implicitly has ALL permissions (checked separately, not listed here).

const ROLES = [
  'student',
  'parent',
  'teacher',
  'institution_owner',
  'institution_staff',
  'employer',
  'education_agent',
  'donor',
  'academy_owner',
  'marketplace_seller',
  'platform_staff',
  'admin',
  'super_admin'
];

// Roles every new registered user gets automatically (base account).
const DEFAULT_ROLES = ['student'];

// Roles that require an approval workflow (role request -> admin approval) before activation.
const APPROVAL_REQUIRED_ROLES = [
  'teacher',
  'institution_owner',
  'institution_staff',
  'employer',
  'education_agent',
  'donor',
  'academy_owner',
  'marketplace_seller'
];

const PERMISSIONS = {
  student: [
    'student:profile:read:own', 'student:profile:update:own',
    'institution:read', 'institution:connect:own',
    'course:read', 'course:enroll:own',
    'assignment:read:own', 'assignment:submit:own',
    'attendance:read:own',
    'result:read:own'
  ],
  parent: [
    'parent:profile:read:own', 'parent:profile:update:own',
    'child:link:request', 'child:read:linked',
    'student:academic:read:linked'
  ],
  teacher: [
    'teacher:profile:read:own', 'teacher:profile:update:own',
    'course:create:own', 'course:update:own', 'course:read',
    'lesson:create:own', 'lesson:update:own',
    'class:read:own', 'class:manage:own',
    'attendance:mark:own',
    'assignment:create:own', 'assignment:grade:own',
    'result:record:own'
  ],
  institution_owner: [
    'institution:create', 'institution:update:own', 'institution:read',
    'institution:staff:manage:own', 'institution:student:manage:own',
    'institution:teacher:manage:own', 'institution:course:manage:own',
    'institution:reports:read:own'
  ],
  institution_staff: [
    'institution:read', 'institution:student:manage:assigned',
    'institution:teacher:manage:assigned', 'institution:course:manage:assigned'
  ],
  employer: [
    'job:create:own', 'job:update:own', 'job:read',
    'application:read:own', 'application:manage:own'
  ],
  education_agent: [
    'agent:case:manage:own', 'agent:commission:read:own'
  ],
  donor: [
    'scholarship:create:own', 'scholarship:read', 'donation:manage:own'
  ],
  academy_owner: [
    'institution:create', 'institution:update:own', 'institution:read'
  ],
  marketplace_seller: [
    'product:create:own', 'product:update:own', 'order:read:own'
  ],
  platform_staff: [
    'verification:review', 'complaint:review', 'support:manage'
  ],
  admin: [
    'user:manage', 'institution:manage', 'verification:manage',
    'complaint:manage', 'finance:read', 'commission:manage',
    'config:manage', 'reports:read'
  ]
  // super_admin: implicit wildcard '*'
};

function getPermissionsForRoles(roles = []) {
  if (roles.includes('super_admin')) return ['*'];
  const set = new Set();
  roles.forEach((r) => (PERMISSIONS[r] || []).forEach((p) => set.add(p)));
  return Array.from(set);
}

function hasPermission(userPermissions = [], required) {
  if (!required) return true;
  if (userPermissions.includes('*')) return true;
  return userPermissions.includes(required);
}

module.exports = {
  ROLES,
  DEFAULT_ROLES,
  APPROVAL_REQUIRED_ROLES,
  PERMISSIONS,
  getPermissionsForRoles,
  hasPermission
};
