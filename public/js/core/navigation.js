// One contract for login return targets and programmatic router navigation.
const encodedUnsafe = /%(?:25)*(?:5c|0[0-9a-f]|1[0-9a-f]|7f)/i;

/** Parse an untrusted target without allowing URL normalization to hide syntax. */
export function localTarget(target, { origin = location.origin, allowPath = () => true } = {}) {
  if (typeof target !== 'string' || !target || /[\\\u0000-\u0020\u007f]/.test(target) || encodedUnsafe.test(target)) return null;
  if (!(target.startsWith('/') && !target.startsWith('//')) && !/^https?:\/\//i.test(target)) return null;
  try {
    const url = new URL(target, origin);
    if (url.origin !== origin || url.username || url.password) return null;
    // Check the original path: URL() has already removed literal/encoded dot segments.
    const path = target.replace(/^https?:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0] || '/';
    const decoded = decodeURIComponent(path);
    if (/%[0-9a-f]{2}/i.test(decoded) || /%2f/i.test(path) || decoded.includes('//') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded)) return null;
    if (!allowPath(url.pathname)) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

// These match the post-login routes in player/app.js and admin/app.js.
const playerPaths = /^(?:\/(?:welcome|sports-rates|court-calendar|notifications|profile)|\/credits(?:\/[^/]+)?|\/book(?:\/[^/]+){0,4}|\/bookings(?:\/[^/]+(?:\/(?:held|pay|gcash|submitted|confirmed|cancelled|chat))?)?)\/?$/;
const consolePaths = /^\/(?:verify(?:\/[^/]+)?|bookings(?:\/[^/]+)?|messages(?:\/[^/]+)?|notifications|disruptions(?:\/[^/]+)?|credits(?:\/[^/]+)?|calendar|facilities|availability|profile|more)\/?$/;

export function loginReturnTarget(target, { portal = 'player', origin = location.origin } = {}) {
  const base = portal === 'staff' ? '/staff' : portal === 'admin' ? '/admin' : '';
  const fallback = base + '/';
  const allowPath = (path) => {
    if (!base) return path === '/' || playerPaths.test(path);
    if (portal === 'admin' && /^\/revenue\/?$/.test(path)) return true;
    if (path === base || path === base + '/') return true;
    if (!path.startsWith(base + '/')) return false;
    const rest = path.slice(base.length);
    return consolePaths.test(rest) || (portal === 'admin' && /^\/settings\/?$/.test(rest));
  };
  return localTarget(target, { origin, allowPath }) || fallback;
}
