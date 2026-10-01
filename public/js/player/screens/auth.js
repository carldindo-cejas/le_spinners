import { api } from '../../core/api.js';
import { newPasswordCredentials, passwordProof } from '../../core/credentials.js';
import { $, html, on, render, setBusy } from '../../core/dom.js';
import { icon, logo, courtArt } from '../../core/icons.js';
import { clearFieldErrors, showFieldErrors, toast } from '../../core/ui.js';
import { navigate, show, startBadges, state } from '../shell.js';

function safeNext(query) {
  const next = query.get('next') || '/';
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/admin') || next.startsWith('/login') || next.startsWith('/register')) return '/';
  return next;
}

function passwordField({ name = 'password', autocomplete = 'current-password', label = 'Password', extra = '' }) {
  return html`<div class="field">
    <label class="label" for="f-${name}">${label}${extra}</label>
    <div class="input-group">
      <input class="input" id="f-${name}" name="${name}" type="password" autocomplete="${autocomplete}" required minlength="${name === 'password' && autocomplete === 'new-password' ? 8 : 1}" maxlength="128">
      <button class="suffix-btn" type="button" data-act="toggle-pw" aria-label="Show password" aria-pressed="false">${icon('eye', 20)}</button>
    </div>
  </div>`;
}

function wirePasswordToggles(root) {
  on(root, 'click', '[data-act="toggle-pw"]', (_e, btn) => {
    const input = btn.parentElement.querySelector('input');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.setAttribute('aria-pressed', String(!showing));
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    render(btn, icon(showing ? 'eye' : 'eye-off', 20));
  });
}

async function afterSignIn(user, next) {
  state.user = user;
  try {
    state.facility = await api.get('/api/facility');
  } catch {
    /* keep the old copy */
  }
  startBadges();
  navigate(next, { replace: true });
}

// ── U01 Log in ─────────────────────────────────────────────────────────────

export function loginView({ query }) {
  const next = safeNext(query);
  const root = show(html`<div class="auth screen-enter">
    <div class="auth-court">${courtArt()}</div>
    <div class="auth-brand">${logo(40)}<span class="brand-name">Le Spinners</span></div>
    <div class="stack stack-8">
      <h1 class="h1">Welcome back</h1>
      <p class="body">Log in to book courts and tables, and to follow your bookings.</p>
    </div>
    <form novalidate data-form="login">
      <div class="banner error compact" role="alert" data-form-error hidden></div>
      <div class="field">
        <label class="label" for="f-email">Email</label>
        <input class="input" id="f-email" name="email" type="email" inputmode="email" autocomplete="username" required maxlength="254" autofocus>
      </div>
      ${passwordField({})}
      <label class="check-row"><input type="checkbox" name="remember" checked><span class="check-box">${icon('check', 16, 3)}</span>Keep me logged in on this device</label>
      <button class="btn btn-primary btn-lg btn-block" type="submit">Log in</button>
    </form>
    <div class="foot">
      <p class="or-divider">New to Le Spinners?</p>
      <a class="btn btn-secondary btn-block" href="/register${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}">Create an account</a>
      <p class="meta center">Members and non-members use the same app. Your membership shows on your profile once staff confirm it.</p>
    </div>
  </div>`);
  wirePasswordToggles(root);
  const form = $('[data-form="login"]', root);
  const errorBox = $('[data-form-error]', root);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    errorBox.hidden = true;
    const data = new FormData(form);
    const email = String(data.get('email') || '').trim();
    const password = String(data.get('password') || '');
    if (!email || !password) {
      showFieldErrors(form, { ...(email ? {} : { email: ['Enter your email.'] }), ...(password ? {} : { password: ['Enter your password.'] }) });
      return;
    }
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Logging in…');
    try {
      const clientHash = await passwordProof(email, password);
      const res = await api.post('/api/auth/login', { email, clientHash, remember: data.get('remember') === 'on' }, { quiet401: true });
      await afterSignIn(res.user, next);
    } catch (err) {
      setBusy(btn, false);
      if (err.details && showFieldErrors(form, err.details)) return;
      errorBox.hidden = false;
      errorBox.textContent = err.message;
      form.querySelector('#f-password').focus();
    }
  });
}

// ── U02 Create account ─────────────────────────────────────────────────────

function strength(pw) {
  if (!pw) return { score: 0, label: 'At least 8 characters', cls: '' };
  if (pw.length < 8) return { score: 1, label: 'Too short — at least 8 characters', cls: 'weak' };
  let score = 2;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw) || /[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.length >= 12) score = Math.min(4, score + 1);
  return score >= 4 ? { score: 4, label: 'Strong', cls: 'good' } : score === 3 ? { score: 3, label: 'Good — at least 8 characters', cls: 'good' } : { score: 2, label: 'Fair — add numbers or symbols', cls: 'fair' };
}

export function registerView({ query }) {
  const next = safeNext(query);
  let member = false;
  const root = show(html`<div class="auth screen-enter">
    <a class="icon-btn" href="/login" aria-label="Back to log in">${icon('chevron-left', 22, 2.2)}</a>
    <div class="stack stack-8">
      <h1 class="h1">Create your account</h1>
      <p class="body">Book courts and tables, pay with GCash, and chat with staff about each booking.</p>
    </div>
    <form novalidate data-form="register">
      <div class="banner error compact" role="alert" data-form-error hidden></div>
      <div class="field">
        <label class="label" for="f-name">Full name</label>
        <input class="input" id="f-name" name="name" autocomplete="name" required maxlength="80" placeholder="e.g. Juan Dela Cruz">
      </div>
      <div class="field">
        <label class="label" for="f-email">Email</label>
        <input class="input" id="f-email" name="email" type="email" inputmode="email" autocomplete="email" required maxlength="254">
      </div>
      <div class="field">
        <label class="label" for="f-phone">Mobile number</label>
        <div class="input-group"><span class="prefix">+63</span><input class="input" id="f-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="917 123 4567" maxlength="14" aria-describedby="phone-help"></div>
        <p class="help" id="phone-help">For booking updates. Never shown to other players.</p>
      </div>
      <div class="field">
        <label class="label" for="f-password">Password</label>
        <div class="input-group">
          <input class="input" id="f-password" name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128" aria-describedby="pw-meter">
          <button class="suffix-btn" type="button" data-act="toggle-pw" aria-label="Show password" aria-pressed="false">${icon('eye', 20)}</button>
        </div>
        <div class="pw-meter" id="pw-meter" aria-live="polite"><span class="bars"><i></i><i></i><i></i><i></i></span><span class="pw-label">At least 8 characters</span></div>
      </div>
      <fieldset class="field fieldset">
        <legend class="label">Are you a Le Spinners member?</legend>
        <div class="seg" role="group" aria-label="Membership">
          <button type="button" data-member="no" aria-pressed="true">Not yet</button>
          <button type="button" data-member="yes" aria-pressed="false">I'm a member</button>
        </div>
        <div class="stack stack-8" data-member-fields hidden>
          <label class="label" for="f-code">Member code (from your member card)</label>
          <input class="input mono" id="f-code" name="memberCode" autocomplete="off" maxlength="20" placeholder="LS-M-0142">
          <p class="banner warn compact">${icon('info', 18, 2.2)}<span>Staff confirm your code. Until then your account shows "Membership pending" and non-member rates apply.</span></p>
        </div>
      </fieldset>
      <label class="check-row"><input type="checkbox" name="agree" required><span class="check-box">${icon('check', 16, 3)}</span><span>I agree to the <b>house rules</b> and <b>privacy policy</b>.</span></label>
      <button class="btn btn-primary btn-lg btn-block" type="submit">Create account</button>
    </form>
    <p class="small center">Already have an account? <a href="/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}">Log in</a></p>
  </div>`);
  wirePasswordToggles(root);
  const form = $('[data-form="register"]', root);
  const f = (n) => form.elements.namedItem(n);
  const errorBox = $('[data-form-error]', root);
  const meter = $('#pw-meter', root);

  f('password').addEventListener('input', () => {
    const s = strength(f('password').value);
    meter.className = `pw-meter s${s.score} ${s.cls}`;
    meter.querySelector('.pw-label').textContent = s.label;
  });

  on(root, 'click', '[data-member]', (_e, btn) => {
    member = btn.dataset.member === 'yes';
    for (const b of root.querySelectorAll('[data-member]')) b.setAttribute('aria-pressed', String(b === btn));
    $('[data-member-fields]', root).hidden = !member;
    if (member) f('memberCode').focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    errorBox.hidden = true;
    const name = f('name').value.trim();
    const email = f('email').value.trim();
    const digits = f('phone').value.replace(/\D/g, '').replace(/^63(?=9\d{9}$)/, '').replace(/^0/, '');
    const password = f('password').value;
    const code = member ? f('memberCode').value.trim() : '';
    const errors = {};
    if (name.length < 2) errors.name = ['Enter your full name.'];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = ['Enter a valid email address.'];
    if (digits && !/^9\d{9}$/.test(digits)) errors.phone = ['Enter a 10-digit mobile number, like 917 123 4567.'];
    if (password.length < 8) errors.password = ['Use at least 8 characters.'];
    if (member && !/^[A-Za-z0-9-]{3,20}$/.test(code)) errors.memberCode = ['Enter the code on your member card.'];
    if (!f('agree').checked) errors.agree = ['Please agree to the house rules and privacy policy.'];
    if (Object.keys(errors).length) {
      showFieldErrors(form, errors);
      return;
    }
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Creating account…');
    try {
      const body = { name, email, password: await newPasswordCredentials(password), ...(digits ? { phone: `+63 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}` } : {}), ...(code ? { memberCode: code } : {}) };
      const res = await api.post('/api/auth/register', body, { quiet401: true });
      toast('Account created', { sub: code ? 'Staff will confirm your member code.' : 'You can book right away.' });
      await afterSignIn(res.user, next);
    } catch (err) {
      setBusy(btn, false);
      if (err.details && showFieldErrors(form, err.details)) return;
      errorBox.hidden = false;
      errorBox.textContent = err.message;
    }
  });
}
