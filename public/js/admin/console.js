/**
 * The staff console (/staff/) and the admin console (/admin/) run the same screens.
 * Which one this is comes from the page URL; the server enforces the role on every
 * API call either way (/api/staff/* lets staff and admins in, /api/admin/* admins only).
 */
const staff = location.pathname === '/staff' || location.pathname.startsWith('/staff/');

export const CONSOLE = staff
  ? { kind: 'staff', role: 'staff', title: 'Staff console', roleLabel: 'Staff', loginApi: '/api/auth/staff/login' }
  : { kind: 'admin', role: 'admin', title: 'Admin console', roleLabel: 'Administrator', loginApi: '/api/auth/admin/login' };

/** Page prefix: `${BASE}/verify/…` */
export const BASE = staff ? '/staff' : '/admin';
/** API prefix: `${API}/bookings/…` */
export const API = staff ? '/api/staff' : '/api/admin';
export const isAdminConsole = !staff;
/** Admin-only pages with their own top-level address (served the admin shell). */
export const REVENUE = '/revenue/';

/** Staff notifications store links as /admin/…; open them in this console. */
export function consoleLink(link) {
  if (typeof link !== 'string') return `${BASE}/`;
  return link.startsWith('/admin/') ? BASE + link.slice('/admin'.length) : link;
}

/** The dashboard for a role, from /api/auth/session's `home`. */
export const HOME = { player: '/', staff: '/staff/', admin: '/admin/' };