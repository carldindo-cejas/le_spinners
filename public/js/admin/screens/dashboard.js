import { api } from '../../core/api.js';
import { $, html, render } from '../../core/dom.js';
import { icon, logo } from '../../core/icons.js';
import {
  bookingTime, clock, dateLabel, firstName, greeting, initials, isoDate, longDate, minutesBetween, minutesLabel, mmss, peso, relTime, shortDate,
} from '../../core/format.js';
import { errorState, memberTag, poll, skeletonRows, statusPill } from '../../core/ui.js';
import { frame, state } from '../shell.js';
import { API, BASE } from '../console.js';

export function waitLabel(submittedAt, now, oldest) {
  const m = minutesBetween(submittedAt, now);
  return html`<span class="wait${oldest ? ' old' : ''}">${icon('clock', 15, 2.2)}${oldest ? `Waiting ${m} min` : m < 1 ? 'just now' : `${m} min ago`}</span>`;
}

function pvSection(d) {
  const items = d.verification;
  return html`<section class="pv" aria-labelledby="pv-title">
    <div class="pv-head">
      <span class="tile violet-solid">${icon('shield-clock', 20)}</span>
      <h2 id="pv-title">Payment verification · ${items.length} pending</h2>
      <span class="small">Oldest first</span>
      <a class="btn btn-secondary btn-xs ml-auto" href="${BASE}/verify">Open queue</a>
    </div>
    ${items.length ? items.slice(0, 5).map((b, i) => html`<a class="pv-row" href="${BASE}/verify/${b.id}">
      ${b.proof ? html`<img class="thumb" src="${b.proof.url || ''}" alt="" data-proof-thumb="${b.proof.id}">` : html`<span class="thumb"></span>`}
      <span class="stack stack-4"><span class="who-line">${b.user.name}${memberTag(b.user.membership, { small: true })}</span>
        <span class="pv-mobile small">${b.resource.name} · ${shortDate(b.date)} · ${bookingTime(b)} · ${b.amountLabel}</span>
        <span class="pv-mobile">${waitLabel(b.submittedAt, d.now, i === 0)}</span></span>
      <span class="pv-where"><span class="strong">${b.activityLabel} — ${b.resource.name}</span><br><span class="small">${shortDate(b.date)} • ${bookingTime(b)}</span></span>
      <span class="pv-amt mono">${b.amountLabel}</span>
      <span class="pv-wait">${waitLabel(b.submittedAt, d.now, i === 0)}</span>
      <span class="btn btn-primary btn-sm">Review</span>
    </a>`) : html`<p class="panel-body small">Nothing to verify right now. New payment proofs show up here the moment players upload them.</p>`}
  </section>`;
}

function todayList(d) {
  const nowMin = (() => {
    const t = new Date(d.now + 8 * 3_600_000);
    return t.getUTCHours() * 60 + t.getUTCMinutes();
  })();
  const rows = d.todaySchedule;
  if (!rows.length) return html`<p class="small">No bookings today yet.</p>`;
  const out = [];
  let nowShown = false;
  for (const b of rows) {
    if (!nowShown && b.start > nowMin) {
      out.push(html`<div class="now-line">NOW ${clock(d.now)}</div>`);
      nowShown = true;
    }
    // A booking with gaps is only "playing" inside one of its booked ranges.
    const playing = b.status === 'CONFIRMED' && (b.segments?.length ? b.segments : [b]).some((s) => s.start <= nowMin && s.end > nowMin);
    const done = b.end <= nowMin;
    out.push(html`<a class="dl-row${done ? ' done' : ''}" href="${BASE}/bookings/${b.id}">
      <span class="dl-time">${minutesLabel(b.start)}</span>
      <span><span class="strong">${b.resource.name} — ${b.activityLabel}</span><br><span class="small">${b.user.name}${b.segments?.length > 1 ? ` · ${bookingTime(b)}` : ''}${b.status === 'TEMPORARY' ? ' · paying now' : ''}</span></span>
      ${playing ? html`<span class="pill blue sm">${icon('play-circle', 12, 2.4)}Playing now</span>` : b.status === 'TEMPORARY' && b.holdExpiresAt ? html`<span class="pill amber sm">${icon('hourglass', 12, 2.4)}Held · ${mmss(b.holdExpiresAt - d.now)} left</span>` : statusPill(b.status, { small: true })}
    </a>`);
  }
  if (!nowShown) out.push(html`<div class="now-line">NOW ${clock(d.now)}</div>`);
  return html`<div class="day-list">${out}</div>`;
}

/** Courts and tables in maintenance or open play right now, and confirmed bookings still ahead. */
function facilityPanel(d) {
  const f = d.facility;
  if (!f) return '';
  const n = d.counts.upcomingConfirmed ?? 0;
  return html`<section class="panel"><div class="panel-head"><h2 class="panel-title">Facility · ${f.inService} of ${f.total} in service</h2><a class="link-sm" href="${BASE}/facilities">Resources</a></div>
    <div class="panel-body stack stack-8">
      <p class="small"><a href="${BASE}/bookings?status=CONFIRMED&scope=upcoming">${n} confirmed booking${n === 1 ? '' : 's'} coming up</a> · <a href="${BASE}/availability">Hours and closed dates</a></p>
      ${f.maintenance.map((r) => html`<p class="row row-wrap" data-gap="8"><span class="pill amber sm">${icon('wrench', 12, 2.4)}Maintenance</span><span class="strong">${r.name}</span><span class="small">${r.note || ''}${r.untilLabel ? ` · back on ${r.untilLabel}` : ''}</span></p>`)}
      ${(f.openPlay || []).map((r) => html`<p class="row row-wrap" data-gap="8"><span class="pill blue sm">${icon('users', 12, 2.4)}Open play</span><span class="strong">${r.name}</span><span class="small">Free for all · not bookable</span></p>`)}
      ${!f.maintenance.length && !f.openPlay?.length ? html`<p class="small">Every court and table is open for booking.</p>` : ''}
    </div></section>`;
}

export async function dashboardView() {
  const u = state.user;
  const nowStr = `${longDate(isoDate(Date.now()))} · ${clock(Date.now())}`;
  const root = frame({
    key: 'dashboard',
    eyebrow: nowStr,
    title: 'Dashboard',
    actions: html`<span class="live only-desktop"><span class="live-dot"></span>Live</span>`,
    mobileHeader: html`<div class="tb-mobile"><div class="row row-between"><a class="sb-brand" href="${BASE}/">${logo(34)}<span><span class="n1">Le Spinners</span><br><span class="n2">STAFF</span></span></a><div class="row" data-gap="8"><a class="icon-btn" href="${BASE}/notifications" aria-label="Notifications">${icon('bell', 21)}${state.badges.unresolved ? html`<span class="badge" aria-hidden="true">${state.badges.unresolved}</span>` : ''}</a><a class="avatar volt" href="${BASE}/more" aria-label="More">${initials(u.name)}</a></div></div>
      <div><p class="m-title">${greeting()}, ${firstName(u.name)}</p><p class="small light-text">${dateLabel(isoDate(Date.now()))} · ${clock(Date.now())}</p></div></div>`,
    template: html`<div class="page" data-page>
      <div class="row row-between only-desktop"><h2 class="h1">${greeting()}, ${firstName(u.name)}</h2><a class="btn btn-secondary btn-md" href="${BASE}/calendar">${icon('calendar-grid', 18)}Open calendar</a></div>
      <div data-body>${skeletonRows(4, 'sk-card')}</div>
    </div>`,
  });
  const body = $('[data-body]', root);

  async function load() {
    try {
      const [d, inbox] = await Promise.all([api.get(`${API}/summary`), api.get(`${API}/messages`)]);
      const unreadConvs = inbox.conversations.filter((c) => c.unread > 0);
      const oldest = d.verification[0];
      const expiring = d.holds.filter((h) => h.holdExpiresAt && h.holdExpiresAt - d.now <= 2 * 60_000);
      const nextHold = d.holds[0];
      const pickleball = d.todaySchedule.filter((b) => b.activity === 'pickleball').length;
      const total = d.todaySchedule.length;
      render(body, html`<div class="stack stack-20">
        <section class="stack stack-12" aria-label="Needs attention">
          <p class="eyebrow only-desktop">Needs attention</p>
          <div class="attn-grid">
            <a class="attn violet" href="${BASE}/verify"><span class="eyebrow">Payment verification</span><span class="num">${d.counts.pendingVerification}</span><span class="sub">${oldest ? `pending · oldest waiting ${minutesBetween(oldest.submittedAt, d.now)} min` : 'nothing pending'}</span></a>
            <a class="attn" href="${BASE}/messages"><span class="eyebrow">Unread messages</span><span class="num">${d.counts.unreadChats}</span><span class="sub">${unreadConvs.length ? `from ${unreadConvs.slice(0, 2).map((c) => firstName(c.userName)).join(' and ')}` : 'all caught up'}</span></a>
            <a class="attn" href="${BASE}/bookings?status=holds"><span class="eyebrow">Active holds</span><span class="num">${d.counts.activeHolds}</span><span class="sub">players paying now</span></a>
            <a class="attn${expiring.length ? ' amber' : ''}" href="${BASE}/calendar"><span class="eyebrow">Holds expiring</span><span class="num">${expiring.length}</span><span class="sub">${nextHold ? `${nextHold.resource.name} · ${minutesLabel(nextHold.start).replace(':00', '')} · ${mmss(nextHold.holdExpiresAt - d.now)} left` : 'none right now'}</span></a>
            ${d.counts.disruptionsOpen ? html`<a class="attn amber" href="${BASE}/disruptions?filter=open"><span class="eyebrow">Disruption follow-up</span><span class="num">${d.counts.disruptionsOpen}</span><span class="sub">bookings still to finish</span></a>` : ''}
          </div>
        </section>
        ${pvSection(d)}
        <section class="stack stack-12">
          <p class="eyebrow">Today at a glance</p>
          <div class="stat-grid">
            <div class="panel stat"><span class="eyebrow">Today's bookings</span><span class="num">${total}</span><span class="split-bar" aria-hidden="true"><i data-css="--w:${total ? Math.round((pickleball / total) * 100) : 50}%"></i><i></i></span><span class="small">${pickleball} Pickleball · ${total - pickleball} Table Tennis</span></div>
            <div class="panel stat"><span class="eyebrow">Confirmed today</span><span class="num">${d.counts.confirmedToday}</span><span class="small">verified ${peso(d.verifiedRevenueToday)}</span></div>
            <div class="panel stat"><span class="eyebrow">Active holds</span><span class="num">${d.counts.activeHolds}</span><span class="small">release on their own if unpaid</span></div>
            <div class="panel stat"><span class="eyebrow">Unresolved alerts</span><span class="num">${d.counts.unresolved}</span><span class="small"><a href="${BASE}/notifications">Open notifications</a></span></div>
          </div>
        </section>
        ${facilityPanel(d)}
        <div class="cols c-160-1">
          <section class="panel"><div class="panel-head"><h2 class="panel-title">Today · booking activity</h2><a class="link-sm" href="${BASE}/calendar">Full day</a></div><div class="panel-body">${todayList(d)}</div></section>
          <section class="panel"><div class="panel-head"><h2 class="panel-title">Messages ${d.counts.unreadChats ? html`<span class="pill red sm">${d.counts.unreadChats} unread</span>` : ''}</h2><a class="link-sm" href="${BASE}/messages">All</a></div>
            <div class="panel-body">${inbox.conversations.length ? inbox.conversations.slice(0, 4).map((c) => html`<a class="msg-row" href="${BASE}/messages/${c.bookingId}">
              <span class="u-dot${c.unread ? '' : ' read'}"></span>
              <span class="grow"><span class="row row-between"><span class="strong">${c.userName}</span><span class="meta">${relTime(c.last.at, d.now)}</span></span>
              <span class="meta">${c.resourceName} · ${c.dateLabel}</span><br><span class="small ink2">"${c.last.body}"</span></span></a>`) : html`<p class="small">No conversations yet.</p>`}</div></section>
        </div>
      </div>`);
    } catch (err) {
      render(body, errorState(err));
      $('[data-act="retry"]', body)?.addEventListener('click', load);
    }
  }
  load();
  return poll(load, 20_000);
}
