import { historyPager } from '../../core/history.js';
import { createViewTools } from '../../core/view.js';
import { api } from '../../core/api.js';
import { listen, $, html, on, render, safeUrl } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { isoDate, relTime } from './util.js';
import { errorState, poll, skeletonRows } from '../../core/ui.js';
import { navigate, refreshBadges, show } from '../shell.js';

const viewTools = createViewTools({ listen, api, on, render, poll, navigate, refreshBadges, show });

const LOOK = {
  payment_verified: { tile: 'volt', icon: 'check' },
  new_message: { tile: 'blue', icon: 'chat' },
  proof_submitted: { tile: 'violet', icon: 'shield-clock' },
  hold_created: { tile: 'amber', icon: 'hourglass' },
  hold_expiring: { tile: 'amber', icon: 'hourglass' },
  proof_rejected: { tile: 'red', icon: 'x-circle' },
  booking_cancelled: { tile: 'neutral', icon: 'circle-slash' },
  booking_expired: { tile: 'neutral', icon: 'clock-x' },
  booking_disrupted: { tile: 'neutral', icon: 'calendar-x' },
  booking_partly_credited: { tile: 'blue', icon: 'gift' },
  disruption_pending: { tile: 'amber', icon: 'calendar-x' },
  credit_booking_confirmed: { tile: 'volt', icon: 'check' },
  credit_restored: { tile: 'blue', icon: 'gift' },
  credit_changed: { tile: 'blue', icon: 'gift' },
};

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'bookings', label: 'Bookings' },
  { key: 'messages', label: 'Messages' },
];

function row(n) {
  const look = LOOK[n.type] || { tile: 'blue', icon: 'bell' };
  return html`<li><a class="notif${n.read ? '' : ' unread'}" href="${safeUrl(n.link || '/')}" data-id="${n.id}" data-read="${n.read ? '1' : '0'}">
    <span class="tile sm ${look.tile}">${icon(look.icon, 20)}</span>
    <span class="grow"><span class="n-title">${n.title}</span><span class="n-body">${n.body}</span><span class="n-time">${relTime(n.createdAt)}</span></span>
    ${n.read ? '' : html`<span class="n-dot" aria-label="Unread"></span>`}
  </a></li>`;
}

export function notificationsView() {
  const { listen, show, render, on, api, refreshBadges, navigate, poll } = viewTools();
  let filter = 'all';
  let data = null;
  const root = show(html`<div class="screen has-tabbar screen-enter">
    <div class="page-title-row"><h1 class="h1">Notifications</h1><button type="button" class="btn btn-text btn-sm" data-act="all-read">Mark all read</button></div>
    <div class="chip-row" role="group" aria-label="Filter" data-filters></div>
    <div data-list>${skeletonRows(5)}</div>
  </div>`, { tab: 'alerts', nav: true });
  const list = $('[data-list]', root);
  const pages = historyPager(api, list.parentElement, load);
  const filters = $('[data-filters]', root);

  function paint() {
    render(filters, FILTERS.map((f) => html`<button type="button" class="chip" data-filter="${f.key}" aria-pressed="${filter === f.key ? 'true' : 'false'}">${f.label}</button>`));
    const items = data.notifications;
    if (!items.length) {
      render(list, html`<div class="empty"><span class="tile blue lg">${icon('bell', 26)}</span><p class="empty-title">You're all caught up</p><p class="empty-body">Booking updates and messages from Le Spinners show up here.</p></div>`);
      return;
    }
    const today = isoDate(Date.now());
    const groups = [
      { label: 'Today', items: items.filter((n) => isoDate(n.createdAt) === today) },
      { label: 'Earlier', items: items.filter((n) => isoDate(n.createdAt) !== today) },
    ].filter((g) => g.items.length);
    render(list, groups.map((g) => html`<section class="section"><p class="overline">${g.label}</p><ul class="card notif-list">${g.items.map(row)}</ul></section>`));
    $('[data-act="all-read"]', root).disabled = !data.unread;
  }

  on(filters, 'click', '[data-filter]', (_e, btn) => {
    filter = btn.dataset.filter;
    pages.reset();
    load();
  });
  on(list, 'click', 'a.notif', async (e, a) => {
    if (a.dataset.read === '1') return;
    e.preventDefault();
    const href = a.getAttribute('href');
    api.post('/api/notifications/read', { ids: [a.dataset.id] }).then(refreshBadges).catch(() => {});
    navigate(href);
  });
  on(root, 'click', '[data-act="all-read"]', async () => {
    try {
      await api.post('/api/notifications/read', { all: true });
      await load();
      refreshBadges();
    } catch {
      /* ignore */
    }
  });

  async function load() {
    try {
      data = await pages.get(`/api/notifications?filter=${filter}`);
      paint();
    } catch (err) {
      if (data) return;
      render(list, errorState(err));
      listen($('[data-act="retry"]', list), 'click', load);
    }
  }
  load();
  return poll(load, 20_000);
}
