import { api } from '../../core/api.js';
import { $, html, on, render, safeUrl } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { relTime } from '../../core/format.js';
import { errorState, poll, skeletonRows } from '../../core/ui.js';
import { frame, navigate, refreshBadges, state } from '../shell.js';
import { API, BASE, consoleLink, isAdminConsole } from '../console.js';

const KIND = {
  proof_submitted: { label: 'Payment proof submitted', tile: 'violet', icon: 'shield-clock', action: 'Review payment', group: 'verification' },
  new_message: { label: 'New message', tile: 'blue', icon: 'chat', action: 'Open chat', group: 'messages' },
  hold_expiring: { label: 'Payment window expiring', tile: 'amber', icon: 'hourglass', action: 'View booking', group: 'bookings' },
  new_booking: { label: 'New booking created', tile: 'green', icon: 'calendar-plus', action: 'View booking', group: 'bookings' },
  booking_cancelled: { label: 'Booking cancelled', tile: 'neutral', icon: 'circle-slash', action: 'View booking', group: 'bookings' },
  disruption: { label: 'Disruption', tile: 'amber', icon: 'calendar-x', action: 'Open the record', group: 'bookings' },
};

const FILTERS = [
  { key: 'unresolved', label: 'Unresolved' },
  { key: 'all', label: 'All' },
  { key: 'verification', label: 'Verification', violet: true },
  { key: 'messages', label: 'Messages' },
  { key: 'bookings', label: 'Bookings' },
];

/**
 * Alert setup for the side panel. Admins see the recipients (from Settings);
 * staff see only how many are set up (from /rules).
 */
async function alertSetup() {
  if (!state.alerts) {
    try {
      if (isAdminConsole) {
        const res = await api.get('/api/admin/settings');
        const { staffAlertEmails: emails, staffAlertSms: sms } = res.settings;
        state.alerts = { email: emails.length, sms: sms.length, emailTo: emails.join(', '), smsTo: sms.join(', '), delivery: res.delivery };
      } else {
        const res = await api.get(`${API}/rules`);
        const n = (k, noun) => `${k} ${noun}${k === 1 ? '' : 's'} set up by an administrator`;
        state.alerts = { email: res.alerts.emailRecipients, sms: res.alerts.smsRecipients, emailTo: n(res.alerts.emailRecipients, 'address'), smsTo: n(res.alerts.smsRecipients, 'number'), delivery: res.delivery };
      }
    } catch {
      state.alerts = { email: 0, sms: 0, emailTo: '', smsTo: '', delivery: null };
    }
  }
  return state.alerts;
}

function channels(n, a) {
  const email = a.email ? (a.delivery?.email === 'resend' ? '✓' : 'queued') : 'off';
  if (n.type === 'proof_submitted') return `In-app ✓ · Email ${email} · SMS ${a.sms ? 'queued' : 'off'}`;
  if (n.type === 'booking_cancelled') return `In-app ✓ · Email ${email}`;
  return 'In-app ✓';
}

export async function notificationsView() {
  const s = await alertSetup();
  let filter = 'unresolved';
  let data = null;
  const root = frame({
    key: 'notifications',
    title: 'Notifications',
    actions: html`<button type="button" class="btn btn-secondary btn-sm" data-act="read-all">Mark all as read</button>`,
    template: html`<div class="page"><div class="cols c-main-aside">
      <div class="stack stack-16">
        <div class="row row-between only-mobile"><span></span><button type="button" class="btn btn-text btn-sm" data-act="read-all">Mark all read</button></div>
        <div class="chip-row" role="group" aria-label="Filter" data-filters></div>
        <div class="panel" data-list>${skeletonRows(5)}</div>
      </div>
      <aside class="stack stack-16">
        <section class="panel panel-body stack stack-12"><p class="eyebrow">How you're alerted</p>
          <div class="channel"><span class="tile sm blue">${icon('bell', 18)}</span><span><b>In-app</b><br><span class="small">Toasts, bell and sidebar badges for every event.</span></span><span class="pill green sm">On</span></div>
          <div class="channel"><span class="tile sm blue">${icon('send', 18)}</span><span><b>Email</b><br><span class="small">${s.email ? s.emailTo : 'No recipients yet'}</span></span><span class="pill ${s.email ? 'green' : 'neutral'} sm">${s.email ? (s.delivery?.email === 'resend' ? 'On' : 'Queued') : 'Off'}</span></div>
          <div class="channel"><span class="tile sm blue">${icon('phone', 18)}</span><span><b>SMS</b><br><span class="small">${s.sms ? s.smsTo : 'No numbers yet'}</span></span><span class="pill amber sm">Queued</span></div>
          <p class="small">SMS provider not connected yet. Messages are stored and will send once it's set up.${s.delivery?.email === 'resend' ? '' : ' Email sends once RESEND_API_KEY and EMAIL_FROM are set.'}</p>
          ${isAdminConsole ? html`<a class="link-sm" href="/admin/settings#alerts">Alert settings</a>` : html`<p class="small">Recipients are managed by an administrator.</p>`}
        </section>
      </aside>
    </div></div>`,
  });
  const list = $('[data-list]', root);

  function paint() {
    const counts = { unresolved: data.unresolved, all: data.notifications.length };
    for (const g of ['verification', 'messages', 'bookings']) counts[g] = data.notifications.filter((n) => !n.resolved && (KIND[n.type]?.group ?? 'bookings') === g).length;
    render($('[data-filters]', root), FILTERS.map((f) => html`<button type="button" class="chip${f.violet ? ' violet' : ''}" data-filter="${f.key}" aria-pressed="${String(filter === f.key)}">${f.label}${f.key === 'all' ? '' : ` · ${counts[f.key]}`}</button>`));
    const items = data.notifications.filter((n) => (filter === 'all' ? true : filter === 'unresolved' ? !n.resolved : !n.resolved && (KIND[n.type]?.group ?? 'bookings') === filter));
    if (!items.length) {
      render(list, html`<div class="empty empty-center"><span class="tile green lg">${icon('check-circle', 26)}</span><p class="empty-title">Nothing needs you right now</p><p class="empty-body">New payment proofs, messages and holds show up here.</p></div>`);
      return;
    }
    render(list, items.map((n) => {
      const k = KIND[n.type] || { label: n.type.replace(/_/g, ' '), tile: 'blue', icon: 'bell', action: 'View booking' };
      const href = n.type === 'proof_submitted' && n.bookingId ? `${BASE}/verify/${n.bookingId}` : safeUrl(consoleLink(n.link));
      return html`<article class="sn-row${n.read ? ' read' : ''}">
        <span class="tile ${k.tile}">${icon(k.icon, 20)}</span>
        <div class="stack stack-4">
          <span class="sn-kind">${n.resolved ? '' : html`<span class="dot blue-dot" aria-label="Unresolved"></span>`}${k.label} · ${relTime(n.createdAt)}</span>
          <span class="sn-title">${n.title}</span>
          <span class="sn-body">${n.body}</span>
          <span class="meta">${channels(n, s)}</span>
        </div>
        <div class="sn-actions">
          <a class="btn ${n.type === 'proof_submitted' ? 'btn-violet' : 'btn-secondary'} btn-sm" href="${href}" data-open="${n.id}">${k.action}</a>
          ${n.resolved ? '' : html`<button type="button" class="btn btn-text btn-sm" data-resolve="${n.id}">Resolve</button>`}
        </div>
      </article>`;
    }));
  }

  on(root, 'click', '[data-filter]', (_e, btn) => {
    filter = btn.dataset.filter;
    paint();
  });
  on(root, 'click', '[data-open]', (e, a) => {
    e.preventDefault();
    api.post(`${API}/notifications/read`, { ids: [a.dataset.open] }).catch(() => {});
    navigate(a.getAttribute('href'));
  });
  on(root, 'click', '[data-resolve]', async (_e, btn) => {
    btn.disabled = true;
    try {
      await api.post(`${API}/notifications/${btn.dataset.resolve}/resolve`);
      await load();
      refreshBadges();
    } catch {
      btn.disabled = false;
    }
  });
  const readAll = async () => {
    await api.post(`${API}/notifications/read`, { all: true }).catch(() => {});
    await load();
    refreshBadges();
  };
  on(root, 'click', '[data-act="read-all"]', readAll);
  const offTop = on(document.getElementById('topbar'), 'click', '[data-act="read-all"]', readAll);

  async function load() {
    try {
      data = await api.get(`${API}/notifications?filter=all`);
      paint();
    } catch (err) {
      if (!data) {
        render(list, errorState(err));
        $('[data-act="retry"]', list)?.addEventListener('click', load);
      }
    }
  }
  load();
  const stop = poll(load, 20_000);
  return () => {
    stop();
    offTop();
  };
}
