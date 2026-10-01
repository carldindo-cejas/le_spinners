import { api } from '../../core/api.js';
import { passwordProof } from '../../core/credentials.js';
import { $, html, on, setBusy } from '../../core/dom.js';
import { icon, logo, courtArt } from '../../core/icons.js';
import { clearFieldErrors, showFieldErrors } from '../../core/ui.js';
import { bare, navigate, startBadges, state } from '../shell.js';

function safeNext(query) {
  const next = query.get('next') || '/admin/';
  return next.startsWith('/admin') && !next.startsWith('/admin/login') && !next.startsWith('//') ? next : '/admin/';
}

export function loginView({ query }) {
  if (state.user && (state.user.role === 'staff' || state.user.role === 'admin')) {
    navigate(safeNext(query), { replace: true });
    return;
  }
  const root = bare(html`<div class="staff-login">
    <section class="sl-panel">
      <span class="sl-art">${courtArt()}</span>
      <div class="row" data-gap="12">${logo(40)}<span><span class="brand-name">Le Spinners</span><br><span class="overline mc-over volt-text">Staff console</span></span></div>
      <div class="stack stack-12 sl-copy">
        <h1 class="display only-desktop">Run the hub from one place.</h1>
        <h1 class="h1 only-mobile">Staff sign in</h1>
        <p class="body light-text only-desktop">Verify GCash payments, keep court and table schedules right, and answer players in each booking's chat.</p>
        <p class="body light-text only-mobile">Verify payments and answer players from your phone.</p>
        <div class="sl-pills"><span class="sl-pill">${icon('shield-clock', 18)}Payment verification</span><span class="sl-pill">${icon('calendar-clock', 18)}Availability</span><span class="sl-pill">${icon('chat', 18)}Booking chat</span></div>
      </div>
      <p class="small light-text only-desktop">Staff accounts only · every sign-in and payment decision is logged</p>
    </section>
    <div class="sl-form-wrap">
      <form class="sl-form" novalidate data-form>
        <div class="stack stack-8 only-desktop"><h2 class="h2">Staff sign in</h2><p class="small">Use your Le Spinners staff account. Player accounts can't sign in here.</p></div>
        <div class="banner error compact" role="alert" data-error hidden></div>
        <div class="field"><label class="label" for="s-email">Staff email</label><input class="input" id="s-email" name="email" type="email" autocomplete="username" required maxlength="254" autofocus></div>
        <div class="field"><label class="label" for="s-pw">Password</label>
          <div class="input-group"><input class="input" id="s-pw" name="password" type="password" autocomplete="current-password" required maxlength="128"><button class="suffix-btn" type="button" data-act="toggle" aria-label="Show password" aria-pressed="false">${icon('eye', 20)}</button></div></div>
        <button type="submit" class="btn btn-dark btn-lg btn-block">Sign in to staff console ${icon('arrow-right', 20, 2.4, 'volt-text')}</button>
        <p class="lock-line">${icon('lock', 16, 2.2)}<span>Sessions end after 12 hours or when you sign out. Payment screenshots open only inside the console.</span></p>
        <p class="small center only-mobile">Staff accounts only · sign-ins and payment decisions are logged</p>
      </form>
    </div>
  </div>`);
  const form = $('[data-form]', root);
  const err = $('[data-error]', root);
  on(root, 'click', '[data-act="toggle"]', (_e, btn) => {
    const input = $('#s-pw', root);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    err.hidden = true;
    const email = form.elements.namedItem('email').value.trim();
    const password = form.elements.namedItem('password').value;
    if (!email || !password) {
      showFieldErrors(form, { ...(email ? {} : { email: ['Enter your staff email.'] }), ...(password ? {} : { password: ['Enter your password.'] }) });
      return;
    }
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, 'Signing in…');
    try {
      const clientHash = await passwordProof(email, password);
      const res = await api.post('/api/auth/login', { email, clientHash }, { quiet401: true });
      if (res.user.role !== 'staff' && res.user.role !== 'admin') {
        await api.post('/api/auth/logout').catch(() => {});
        setBusy(btn, false);
        err.hidden = false;
        err.textContent = "This is a player account. Player accounts can't sign in to the staff console.";
        return;
      }
      state.user = res.user;
      startBadges();
      navigate(safeNext(query), { replace: true });
    } catch (ex) {
      setBusy(btn, false);
      err.hidden = false;
      err.textContent = ex.message;
    }
  });
}
