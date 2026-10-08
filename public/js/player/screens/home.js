import { createViewTools } from '../../core/view.js';
import { splitBookings } from '../../core/booking-time.js';
import { api } from '../../core/api.js';
import { facilityDirections } from '../../core/facility.js';
import { listen, html, render } from '../../core/dom.js';
import { icon, logo, courtArt } from '../../core/icons.js';
import { bookingTime, dateLabel, dayMonth, firstName, greeting, initials } from './util.js';
import { errorState, memberTag, skeletonRows, statusPill } from '../../core/ui.js';
import { bellButton, show, state } from '../shell.js';
import { bookingCard, bookingHref, resourceTile, startCardCountdowns } from '../components.js';
import { availabilityCalendar, startAvailabilityCalendar } from '../availability-calendar.js';

const viewTools = createViewTools({ listen, api, render, show, startCardCountdowns });

function rateLine(user) {
  if (user.membership === 'member') return html`${memberTag('member')}<span>Member rates apply</span>`;
  if (user.membership === 'pending') return html`${memberTag('pending')}<span>Non-member rates until staff confirm</span>`;
  return html`${memberTag('none')}<span>Non-member rates</span>`;
}

function todayHours(facility) {
  const wd = new Date(`${facility.today}T00:00:00Z`).getUTCDay();
  return facility.hours.find((h) => h.weekday === wd);
}

function upcomingBlock(bookings, now) {
  const next = splitBookings(bookings, now).upcoming[0];
  if (!next) {
    return html`<div class="empty">
      <p class="empty-title">No upcoming bookings</p>
      <p class="empty-body">Courts and tables open 14 days ahead. Book a slot and it shows up here with its status.</p>
      <a class="btn btn-primary btn-md" href="/book">Book a court or table</a>
    </div>`;
  }
  if (next.status === 'TEMPORARY' || next.status === 'REJECTED') return bookingCard(next);
  const days = Math.round((Date.parse(`${next.date}T00:00:00Z`) - Date.parse(`${state.facility.today}T00:00:00Z`)) / 86_400_000);
  const when = days === 0 ? 'TODAY' : days === 1 ? 'TOMORROW' : `IN ${days} DAYS`;
  return html`<article class="card booking-mini">
    <div class="card-head"><span class="overline blue">${next.activityLabel} · ${when}</span>${statusPill(next.status, { small: true })}</div>
    <div class="bm-main">${resourceTile(next.activity)}<div><div class="bm-name">${next.resource.name}</div><div class="small">${dateLabel(next.date)}, ${next.date.slice(0, 4)}</div><div class="small strong ink">${bookingTime(next)}</div></div></div>
    <div class="bm-foot"><a class="btn btn-secondary btn-sm" href="${bookingHref(next)}">View booking</a><a class="btn btn-tonal btn-sm" href="/bookings/${next.id}/chat">${icon('chat', 18)}Chat</a></div>
  </article>`;
}

function recentBlock(bookings) {
  const past = bookings.filter((b) => ['COMPLETED', 'EXPIRED', 'CANCELLED'].includes(b.status)).slice(0, 2);
  if (!past.length) return '';
  return html`<section class="section o-5">
    <div class="section-head"><h2 class="h2">Recent</h2><a href="/bookings?tab=past">History</a></div>
    <div class="card">${past.map((b) => html`<a class="list-row" href="/bookings/${b.id}">
      <span class="row-tile">${icon(b.activity === 'table_tennis' ? 'pingpong' : 'paddle', 20)}</span>
      <span class="grow"><span class="row-title">${b.resource.name} · ${b.activity === 'table_tennis' ? 'Table tennis' : 'Pickleball'}</span><br><span class="row-meta">${dateLabel(b.date)} · ${bookingTime(b)}</span></span>
      ${statusPill(b.status, { small: true, noIcon: true })}
    </a>`)}</div>
  </section>`;
}

function facilityCard(f) {
  const h = todayHours(f);
  const pickleball = f.activities.find((a) => a.id === 'pickleball');
  const tt = f.activities.find((a) => a.id === 'table_tennis');
  const directions = facilityDirections(f.facility);
  const nowMin = (() => {
    const d = new Date(Date.now() + 8 * 3_600_000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  })();
  const openNow = h && h.isOpen && nowMin >= h.open && nowMin < h.close;
  return html`<section class="facility-card o-6" aria-label="Facility">
    <div class="row row-between"><span class="h3">${f.facility.name.replace(' Recreational Hub', ' Hub')}</span>${openNow ? html`<span class="pill volt sm">Open now</span>` : html`<span class="pill sm neutral">Closed now</span>`}</div>
    <p class="f-row">${icon('clock', 18)}Today ${h && h.isOpen ? h.label : 'closed'}</p>
    <p class="f-row">${icon('map-pin', 18)}${f.facility.address || 'Address coming soon'}</p>
    <p class="f-row">${icon('court', 18)}${pickleball?.count ?? 0} pickleball courts · ${tt?.count ?? 0} table tennis tables</p>
    ${directions ? html`<a class="btn btn-sm" href="${directions}" target="_blank" rel="noopener noreferrer">${icon('map-pin', 18)}Directions</a>` : ''}
  </section>`;
}

export function homeView(ctx) {
  const { listen, show, api, render, startCardCountdowns, setTimeout } = viewTools(ctx);
  const u = state.user;
  const f = state.facility;
  const root = show(html`<div class="screen wide has-tabbar screen-enter">
    <header class="home-head">
      <a class="brand" href="/">${logo(38)}<span class="brand-name">Le Spinners</span></a>
      <div class="row" data-gap="8">${bellButton()}<a class="avatar" href="/profile" aria-label="Profile">${initials(u.name)}</a></div>
    </header>
    <div class="home-grid">
      <div class="col">
        <section class="hero o-1">
          <span class="hero-art">${courtArt()}</span>
          <p class="h-date">${dayMonth(f.today)}</p>
          <h1 class="h-title">${greeting()}, ${firstName(u.name)}!</h1>
          <p class="h-rate">${rateLine(u)}</p>
          <a class="btn btn-volt btn-lg" href="/book">${icon('calendar-plus', 20)}Book a court</a>
        </section>
        <section class="quick-grid o-2" aria-label="Quick book" data-quick>
          ${f.activities.map((a) => html`<a class="card card-link quick-card" href="/book/${a.id}">
            <span class="tile blue">${icon(a.id === 'table_tennis' ? 'pingpong' : 'paddle', 24)}</span>
            <span class="q-title">${a.label}</span>
            <span class="q-meta" data-open-count="${a.id}">Checking…</span>
          </a>`)}
        </section>
        ${availabilityCalendar(f)}
      </div>
      <div class="col">
        <div data-credit></div>
        <section class="section o-3">
          <div class="section-head"><h2 class="h2">Upcoming booking</h2><a href="/bookings">See all</a></div>
          <div data-upcoming>${skeletonRows(1, 'sk-card')}</div>
        </section>
        <div data-recent class="col-part o-5"></div>
        ${facilityCard(f)}
      </div>
    </div>
  </div>`, { tab: 'home', nav: true });

  const upcomingEl = root.querySelector('[data-upcoming]');
  const recentEl = root.querySelector('[data-recent]');
  let stopCountdowns = () => {};

  async function loadBookings() {
    try {
      const [res, recent] = await Promise.all([api.get('/api/bookings?group=upcoming&order=soonest&limit=1'),api.get('/api/bookings?group=past&limit=2')]);
      stopCountdowns();
      const credit = res.credits;
      render(root.querySelector('[data-credit]'), credit && credit.available > 0
        ? html`<a class="card card-link credit-banner" href="/credits"><span class="tile blue">${icon('gift', 22)}</span>
            <span class="grow"><span class="strong">You have <span class="mono">${credit.availableLabel}</span> booking credit</span><br><span class="small">It pays for your next booking automatically.</span></span>${icon('chevron-right', 18, 2.2)}</a>`
        : '');
      render(upcomingEl, upcomingBlock(res.bookings, res.now));
      render(recentEl, recentBlock(recent.bookings));
      stopCountdowns = startCardCountdowns(upcomingEl, res.now, () => setTimeout(loadBookings, 1500));
    } catch (err) {
      render(upcomingEl, errorState(err));
      listen(upcomingEl.querySelector('[data-act="retry"]'), 'click', loadBookings);
    }
  }

  const stopAvailability = startAvailabilityCalendar(root, f, ctx);
  loadBookings();
  return () => {
    stopAvailability();
    stopCountdowns();
  };
}
