import { api } from '../../core/api.js';
import { openChangePassword, openEditProfile } from '../../core/account.js';
import { html, on, setBusy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { initials, monthDayYear } from './util.js';
import { memberTag, openModal } from '../../core/ui.js';
import { navigate, show, state, stopBadgePolling } from '../shell.js';

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
});

function membershipCard(u) {
  if (u.membership === 'member') {
    return html`<section class="member-card">
      <div class="row row-between"><span class="overline mc-over">Le Spinners member</span>${memberTag('member', { small: true })}</div>
      <p class="h2">Active member</p>
      <div class="grid-2"><div><p class="mc-label">Member ID</p><p class="mono">${u.memberCode || '—'}</p></div><div><p class="mc-label">Valid until</p><p class="strong">${u.memberUntil ? monthDayYear(u.memberUntil) : '—'}</p></div></div>
      <p class="mc-note">Member rates apply to every booking.</p>
    </section>`;
  }
  if (u.membership === 'pending') {
    return html`<section class="member-card pending">
      <div class="row row-between"><span class="overline mc-over">Membership</span>${memberTag('pending', { small: true })}</div>
      <p class="h2">Waiting for staff</p>
      <p class="mc-note">Staff are confirming your member code${u.memberCode ? html` <span class="mono">${u.memberCode}</span>` : ''}. Non-member rates apply until then.</p>
    </section>`;
  }
  return html`<section class="member-card none">
    <div class="row row-between"><span class="overline mc-over">Membership</span>${memberTag('none', { small: true })}</div>
    <p class="h2">Not a member yet</p>
    <p class="mc-note">Members get lower rates on every booking. Ask at the front desk about joining.</p>
  </section>`;
}

function editProfile() {
  openEditProfile(state.user, {
    onSaved: (user) => {
      state.user = user;
      profileView();
    },
  });
}

function changePassword() {
  openChangePassword(state.user.email);
}

function installHelp() {
  if (installEvent) {
    installEvent.prompt();
    installEvent.userChoice.finally(() => (installEvent = null));
    return;
  }
  openModal({
    sheet: true,
    label: 'Install the app',
    content: () => html`<div class="sheet-head"><h2 class="h3">Install Le Spinners</h2><button type="button" class="icon-btn sm flat" data-close aria-label="Close">${icon('x', 18, 2.2)}</button></div>
      <p class="body">Book from your home screen, like any other app.</p>
      <ol class="steps-list">
        <li><span class="n blue">1</span><span><b>iPhone:</b> open this page in Safari, tap Share, then <b>Add to Home Screen</b>.</span></li>
        <li><span class="n blue">2</span><span><b>Android:</b> open the browser menu (⋮) and tap <b>Install app</b> or <b>Add to Home screen</b>.</span></li>
      </ol>
      <button type="button" class="btn btn-secondary btn-block" data-close>Got it</button>`,
  });
}

export async function profileView() {
  const u = state.user;
  let count = null;
  const root = show(html`<div class="screen has-tabbar screen-enter">
    <h1 class="h1">Profile</h1>
    <section class="stack stack-8 center-col">
      <span class="avatar lg">${initials(u.name)}</span>
      <p class="h3">${u.name}</p>
      <p class="small">${u.email}</p>
      ${u.phone ? html`<p class="small">${u.phone}</p>` : ''}
    </section>
    ${membershipCard(u)}
    <nav class="card menu" aria-label="Account">
      <button type="button" class="list-row" data-act="edit"><span class="row-tile">${icon('user', 20)}</span><span class="grow row-title">Personal information</span>${icon('chevron-right', 18, 2.2, 'chev')}</button>
      <div class="list-row"><span class="row-tile">${icon('shield-check', 20)}</span><span class="grow row-title">Membership</span><span class="small strong ${u.membership === 'member' ? 'green-text' : ''}">${u.membership === 'member' ? 'Active' : u.membership === 'pending' ? 'Pending' : 'Not a member'}</span></div>
      <a class="list-row" href="/bookings?tab=past"><span class="row-tile">${icon('ticket', 20)}</span><span class="grow row-title">Booking history</span><span class="small" data-count></span>${icon('chevron-right', 18, 2.2, 'chev')}</a>
      <button type="button" class="list-row" data-act="password"><span class="row-tile">${icon('lock', 20)}</span><span class="grow row-title">Change password</span>${icon('chevron-right', 18, 2.2, 'chev')}</button>
      <button type="button" class="list-row" data-act="install"><span class="row-tile tile-blue">${icon('install', 20)}</span><span class="grow row-title">Install the app</span>${icon('chevron-right', 18, 2.2, 'chev')}</button>
    </nav>
    <button type="button" class="btn btn-secondary btn-block logout-btn" data-act="logout">${icon('logout', 20)}Log out</button>
  </div>`, { tab: 'profile', nav: true });
  on(root, 'click', '[data-act="edit"]', editProfile);
  on(root, 'click', '[data-act="password"]', changePassword);
  on(root, 'click', '[data-act="install"]', installHelp);
  on(root, 'click', '[data-act="logout"]', async (_e, btn) => {
    setBusy(btn, true, 'Logging out…');
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* signed out locally anyway */
    }
    state.user = null;
    stopBadgePolling();
    navigate('/login', { replace: true });
  });
  try {
    const res = await api.get('/api/bookings');
    count = res.bookings.length;
    const el = root.querySelector('[data-count]');
    if (el) el.textContent = `${count} booking${count === 1 ? '' : 's'}`;
  } catch {
    /* optional */
  }
}
