import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv, Bindings } from './types';
import { loadSession, requireAdmin, requireStaff, roleGuard } from './lib/auth';
import { ApiError, notFound } from './lib/errors';
import { runMaintenance } from './lib/maintenance';
import { MAX_UPLOAD_BYTES } from './lib/images';
import { operationsRoutes } from './routes/admin';
import { adminSettingsRoutes } from './routes/admin-settings';
import { authRoutes, meRoutes } from './routes/auth';
import { bookingRoutes } from './routes/bookings';
import { adminCreditRoutes, creditRoutes } from './routes/credits';
import { facilityRoutes } from './routes/facility';
import { fileRoutes, notificationRoutes } from './routes/notifications';
import { revenueRoutes } from './routes/revenue';
import { adminStaffRoutes } from './routes/admin-staff';

/**
 * Page security headers for responses the Worker itself serves (the console shells).
 * Keep in sync with public/_headers, which covers files served straight from assets.
 */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const PAGE_HEADERS: Record<string, string> = {
  'Content-Security-Policy': PAGE_CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

const API_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

const JSON_LIMIT = 64 * 1024;
const UPLOAD_LIMIT = MAX_UPLOAD_BYTES + 256 * 1024; // the file plus multipart overhead
const UPLOAD_PATHS = [/^\/api\/bookings\/[^/]+\/proof$/, /^\/api\/admin\/settings\/gcash-qr$/, /^\/api\/admin\/payment-methods\/[^/]+\/qr$/];

function errorJson(c: Context<AppEnv>, status: ContentfulStatusCode, code: string, message: string, details?: Record<string, unknown>) {
  return c.json({ error: { code, message, ...(details ? { details } : {}), requestId: c.get('requestId') ?? null } }, status);
}

const app = new Hono<AppEnv>();

// ── API middleware ─────────────────────────────────────────────────────────

app.use('/api/*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
  const h = c.res.headers;
  for (const [k, v] of Object.entries(API_HEADERS)) h.set(k, v);
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  if ((h.get('Content-Type') ?? '').includes('application/json')) h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  h.set('X-Request-Id', c.get('requestId'));
});

// CSRF: state-changing requests must come from this site. SameSite=Lax cookies are the first line.
app.use('/api/*', async (c, next) => {
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = c.req.header('Origin');
    const self = new URL(c.req.url).origin;
    const crossSite = origin ? origin !== self && origin !== c.env.APP_ORIGIN : c.req.header('Sec-Fetch-Site') === 'cross-site';
    if (crossSite) throw new ApiError(403, 'BAD_ORIGIN', 'This request came from another site and was blocked.');
  }
  await next();
});

app.use('/api/*', async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD') return next();
  const upload = UPLOAD_PATHS.some((re) => re.test(c.req.path));
  return bodyLimit({
    maxSize: upload ? UPLOAD_LIMIT : JSON_LIMIT,
    onError: (ctx) =>
      upload
        ? errorJson(ctx, 413, 'FILE_TOO_LARGE', 'This image is too large. The limit is 10 MB — a screenshot is usually well under that.')
        : errorJson(ctx, 413, 'PAYLOAD_TOO_LARGE', 'That request is too large.'),
  })(c, next);
});

app.use('/api/*', loadSession);

// ── API routes ─────────────────────────────────────────────────────────────

app.get('/api/health', (c) => c.json({ ok: true, now: Date.now() }));
app.route('/api/auth', authRoutes);
app.route('/api/me', meRoutes);
app.route('/api', facilityRoutes);
app.route('/api/bookings', bookingRoutes);
app.route('/api/credits', creditRoutes);
app.route('/api/notifications', notificationRoutes);
app.route('/api/files', fileRoutes);
// Role namespaces. The guard runs before any handler; handlers check again.
//   /api/bookings, /api/credits, /api/notifications, /api/availability*  players (routes call requirePlayer)
//   /api/staff/*   staff and admins: operations (verification, bookings, chat, facility, disruptions, credits)
//   /api/admin/*   admins only: the same operations plus staff accounts, settings, prices, the outbox, revenue and credit changes
//   /api/me, /api/files, /api/facility*  shared, checked per route
app.use('/api/staff/*', roleGuard(requireStaff));
app.use('/api/admin/*', roleGuard(requireAdmin));
app.route('/api/staff', operationsRoutes);
app.route('/api/admin', adminSettingsRoutes);
app.route('/api/admin/revenue', revenueRoutes);
app.route('/api/admin/credits', adminCreditRoutes);
app.route('/api/admin/staff', adminStaffRoutes);
app.route('/api/admin', operationsRoutes);
app.all('/api/*', () => {
  throw notFound('No such endpoint.');
});

// ── Console shells (/admin/…, /staff/…, /revenue/) — their own HTML entries, separate from the player app ──
// The shells hold no data; every screen loads through the role-guarded API above.

function consoleShell(base: '/admin/' | '/staff/') {
  return async (c: Context<AppEnv>) => {
    const url = new URL(c.req.url);
    // Up to 12 characters so manifest.webmanifest is served as a file, not the shell.
    const isFile = /\/[^/]+\.[a-z0-9]{1,12}$/i.test(url.pathname);
    const req = isFile ? c.req.raw : new Request(new URL(base, url).toString(), { method: 'GET', headers: c.req.raw.headers });
    const res = await c.env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(PAGE_HEADERS)) out.headers.set(k, v);
    return out;
  };
}

app.get('/admin', (c) => c.redirect('/admin/', 301));
app.get('/admin/', consoleShell('/admin/'));
app.get('/admin/*', consoleShell('/admin/'));
app.get('/staff', (c) => c.redirect('/staff/', 301));
app.get('/staff/', consoleShell('/staff/'));
app.get('/staff/*', consoleShell('/staff/'));
// The revenue page is an admin console screen at its own address; it runs the admin shell.
app.get('/revenue', (c) => c.redirect('/revenue/', 301));
app.get('/revenue/', consoleShell('/admin/'));
app.get('/revenue/*', consoleShell('/admin/'));

// Anything else the Worker sees goes to static assets (SPA fallback for the player app).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

// ── Errors ─────────────────────────────────────────────────────────────────

app.onError((err, c) => {
  if (err instanceof ApiError) return errorJson(c, err.status, err.code, err.message, err.details);
  if (err instanceof HTTPException) return errorJson(c, err.status as ContentfulStatusCode, `HTTP_${err.status}`, err.message || 'Request failed.');
  console.error(JSON.stringify({ msg: 'unhandled error', requestId: c.get('requestId'), path: c.req.path, err: String(err), stack: err instanceof Error ? err.stack : undefined }));
  if (!c.req.path.startsWith('/api/')) return c.text('Something went wrong.', 500);
  return errorJson(c, 500, 'INTERNAL', 'Something went wrong on our side. Please try again.');
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runMaintenance(env, Date.now(), { cron: true }).then((report) => {
        console.log(JSON.stringify({ msg: 'cron maintenance', ...report }));
      }),
    );
  },
} satisfies ExportedHandler<Bindings>;
