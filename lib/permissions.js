/**
 * Module roles and what they allow.
 *
 * A member holds at most one role per module (member_module_roles), in any
 * number of modules. Routes and pages check capabilities, never role names, so
 * changing what a role may do is one edit here. Admins (allowed_users.is_admin)
 * and super admins (ADMIN_PHONES) hold every capability.
 *
 * Support is the existing Recovery call board under its new name.
 */

export const MODULES = {
  logistics: { label: 'Logistics', roles: ['viewer', 'operator', 'manager'] },
  inventory: { label: 'Inventory', roles: ['viewer', 'operator', 'manager'] },
  support: { label: 'Customer Support', roles: ['agent', 'lead'] },
  hr: { label: 'HR', roles: ['manager'] },
};
export const MODULE_KEYS = Object.keys(MODULES);
export const ROLE_LABELS = { viewer: 'Viewer', operator: 'Operator', manager: 'Manager', agent: 'Agent', lead: 'Lead' };

/**
 * Capabilities. Each names one kind of action, enforced on the server:
 *   logistics.view   Orders, shipments, couriers, destinations: read
 *   logistics.edit   Orders and shipments: create, edit, documents, notes,
 *                    Amazon import, reserve/release stock for a shipment, dispatch
 *   logistics.setup  Courier partners and destinations: create, edit
 *   inventory.view   Inventory pages and data: read
 *   inventory.move   Receive, adjust, transfer stock; edit batches; batch documents
 *   inventory.catalog Master SKUs, platform SKUs, master SKU import, suppliers, warehouses
 *   support.work     The call board: carts, statuses, reasons, cart export
 *   hr.view          Jobs, candidates, applications, resumes: read
 *   hr.manage        Jobs: create, edit, publish, close, archive; application
 *                    status and internal notes
 */
export const CAPABILITIES = [
  'logistics.view', 'logistics.edit', 'logistics.setup',
  'inventory.view', 'inventory.move', 'inventory.catalog',
  'support.work',
  'hr.view', 'hr.manage',
];

const GRANTS = {
  logistics: {
    viewer: ['logistics.view'],
    operator: ['logistics.view', 'logistics.edit'],
    manager: ['logistics.view', 'logistics.edit', 'logistics.setup'],
  },
  inventory: {
    viewer: ['inventory.view'],
    operator: ['inventory.view', 'inventory.move'],
    manager: ['inventory.view', 'inventory.move', 'inventory.catalog'],
  },
  support: {
    // A lead has no extra powers yet; team reports stay admin-only.
    agent: ['support.work'],
    lead: ['support.work'],
  },
  hr: {
    manager: ['hr.view', 'hr.manage'],
  },
};

export const isValidAssignment = (module, role) => Boolean(GRANTS[module]?.[role]);

/** Capabilities of a resolved member: { admin, roles: { module: role } }. */
export function capabilitiesOf(access) {
  if (!access?.allowed) return [];
  if (access.admin) return [...CAPABILITIES];
  const caps = new Set();
  for (const [module, role] of Object.entries(access.roles || {})) {
    for (const c of GRANTS[module]?.[role] || []) caps.add(c);
  }
  return CAPABILITIES.filter((c) => caps.has(c));
}

export const can = (caps, cap) => (Array.isArray(cap) ? cap.some((c) => caps.includes(c)) : caps.includes(cap));

/**
 * Where a member lands when a page they asked for is not theirs. Never a page
 * they cannot open, so there is no redirect loop; with nothing at all, the
 * "No module access yet" page.
 */
export function homeFor(caps) {
  if (can(caps, 'support.work')) return '/';
  if (can(caps, 'logistics.view')) return '/orders';
  if (can(caps, 'inventory.view')) return '/inventory';
  if (can(caps, 'hr.view')) return '/hr/jobs';
  return '/no-access';
}

/**
 * The single job the old code understood, for the compatibility fields of
 * /auth/me and for the legacy allowed_users.role column kept for rollback.
 */
export function legacyRole(access) {
  if (access?.admin) return 'admin';
  return access?.roles?.logistics ? 'logistics' : 'caller';
}
