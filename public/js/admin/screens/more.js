import { html } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { initials } from '../../core/format.js';
import { frame, state } from '../shell.js';
import { BASE, CONSOLE, REVENUE, isAdminConsole } from '../console.js';

const row = (href, iconName, title, meta, extra = '') =>
  html`<a class="list-row" href="${href}"><span class="row-tile">${icon(iconName, 20)}</span><span class="grow"><span class="row-title">${title}</span><br><span class="row-meta">${meta}</span></span>${extra}${icon('chevron-right', 18, 2.2, 'chev')}</a>`;

export function moreView() {
  const u = state.user;
  const n = state.badges.unresolved;
  frame({
    key: 'more',
    title: 'More',
    template: html`<div class="page">
      <a class="row panel panel-body me-card" data-gap="14" href="${BASE}/profile"><span class="avatar volt lg">${initials(u.name)}</span><div class="grow"><p class="h3 row" data-gap="8">${u.name}${u.role === 'admin' ? html`<span class="tag sm member">Admin</span>` : html`<span class="tag sm nonmember">Staff</span>`}</p><p class="small">${u.email}</p></div>${icon('chevron-right', 18, 2.2, 'chev')}</a>
      ${isAdminConsole ? html`<p class="eyebrow">Reports</p>
      <nav class="panel menu" aria-label="Reports">${row(REVENUE, 'banknote', 'Revenue', 'Collected payments and the booking ledger')}</nav>` : ''}
      <p class="eyebrow">Facility</p>
      <nav class="panel menu" aria-label="Facility">
        ${row(`${BASE}/facilities`, 'layers', 'Resources', 'Courts and tables, maintenance')}
        ${row(`${BASE}/availability`, 'calendar-clock', 'Availability', 'Weekly hours and closed dates')}
        ${row(`${BASE}/calendar`, 'calendar-grid', 'Calendar', 'Every court and table by the hour')}
        ${row(`${BASE}/bookings`, 'ticket', 'Bookings', 'Search and filter every booking')}
      </nav>
      <p class="eyebrow">${isAdminConsole ? 'People & alerts' : 'Alerts & account'}</p>
      <nav class="panel menu" aria-label="${isAdminConsole ? 'People and alerts' : 'Alerts and account'}">
        ${row(`${BASE}/notifications`, 'bell', 'Notifications', 'In-app, email and SMS alerts', n ? html`<span class="badge inline">${n}</span>` : '')}
        ${isAdminConsole ? row('/admin/settings', 'settings', 'Settings', 'Booking rules, GCash, prices') : ''}
        ${row(`${BASE}/profile`, 'user', 'My profile', 'Name, phone and password')}
      </nav>
      <button type="button" class="btn btn-secondary btn-block logout-btn" data-act="logout">${icon('logout', 20)}Log out</button>
      <p class="small center">${CONSOLE.title} · every approval, rejection and change is logged</p>
    </div>`,
  });
}