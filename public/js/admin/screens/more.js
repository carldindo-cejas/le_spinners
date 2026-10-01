import { html } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { initials } from '../../core/format.js';
import { frame, state } from '../shell.js';

export function moreView() {
  const u = state.user;
  const n = state.badges.unresolved;
  frame({
    key: 'more',
    title: 'More',
    template: html`<div class="page">
      <section class="row panel panel-body" data-gap="14"><span class="avatar volt lg">${initials(u.name)}</span><div><p class="h3 row" data-gap="8">${u.name}${u.role === 'admin' ? html`<span class="tag sm member">Admin</span>` : html`<span class="tag sm nonmember">Staff</span>`}</p><p class="small">${u.email}</p></div></section>
      <p class="eyebrow">Facility</p>
      <nav class="panel menu" aria-label="Facility">
        <a class="list-row" href="/admin/calendar"><span class="row-tile">${icon('calendar-grid', 20)}</span><span class="grow"><span class="row-title">Calendar</span><br><span class="row-meta">Every court and table by the hour</span></span>${icon('chevron-right', 18, 2.2, 'chev')}</a>
        <a class="list-row" href="/admin/bookings"><span class="row-tile">${icon('ticket', 20)}</span><span class="grow"><span class="row-title">Bookings</span><br><span class="row-meta">Search and filter every booking</span></span>${icon('chevron-right', 18, 2.2, 'chev')}</a>
      </nav>
      <p class="eyebrow">People &amp; alerts</p>
      <nav class="panel menu" aria-label="People and alerts">
        <a class="list-row" href="/admin/notifications"><span class="row-tile">${icon('bell', 20)}</span><span class="grow"><span class="row-title">Notifications</span><br><span class="row-meta">In-app, email and SMS alerts</span></span>${n ? html`<span class="badge inline">${n}</span>` : ''}${icon('chevron-right', 18, 2.2, 'chev')}</a>
        <a class="list-row" href="/admin/settings"><span class="row-tile">${icon('settings', 20)}</span><span class="grow"><span class="row-title">Settings</span><br><span class="row-meta">Booking rules, GCash, prices</span></span>${icon('chevron-right', 18, 2.2, 'chev')}</a>
        <a class="list-row" href="/" data-native><span class="row-tile">${icon('external', 20)}</span><span class="grow"><span class="row-title">Player app</span><br><span class="row-meta">See what players see</span></span>${icon('chevron-right', 18, 2.2, 'chev')}</a>
      </nav>
      <button type="button" class="btn btn-secondary btn-block logout-btn" data-act="logout">${icon('logout', 20)}Log out</button>
      <p class="small center">Staff console · every approval, rejection and change is logged</p>
    </div>`,
  });
}
