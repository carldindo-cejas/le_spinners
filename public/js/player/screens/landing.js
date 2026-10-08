import { createViewTools } from '../../core/view.js';
import { api } from '../../core/api.js';
import { facilityDirections } from '../../core/facility.js';
import { listen, html, raw, render } from '../../core/dom.js';
import { icon, logo, courtArt, tableArt } from '../../core/icons.js';
import { poll } from '../../core/ui.js';
import { show, state } from '../shell.js';

const viewTools = createViewTools({ listen, api, render, poll, show });

const SPORTS = [
  { id: 'pickleball', label: 'Pickleball', unit: 'court', icon: 'paddle', copy: 'Bring your doubles partner. Find your next rally.', art: courtArt },
  { id: 'table_tennis', label: 'Table tennis', unit: 'table', icon: 'pingpong', copy: 'A little spin. A friendly challenge. Your table awaits.', art: tableArt },
];
const STATES = {
  available: ['Available', 'check'], held: ['On hold · may reopen', 'hourglass'],
  unavailable: ['Unavailable', 'lock'], booked: ['Booked', 'check-circle'],
  maintenance: ['Maintenance', 'wrench'], open_play: ['Open play · free for all', 'users'],
  closed: ['Closed', 'lock'], past: ['Time passed', 'clock'],
};
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dateText = (date, options) => new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', ...options }).format(new Date(`${date}T12:00:00Z`));
const timeText = (minutes) => `${Math.floor(minutes / 60) % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${minutes % 1440 < 720 ? 'AM' : 'PM'}`;
const bookHref = (path = '/book') => !state.user ? `/login?next=${encodeURIComponent(path)}` : path;

function heroArt() {
  return raw(`<svg class="lp-court-art" viewBox="0 0 560 510" fill="none" aria-hidden="true" focusable="false">
    <circle cx="290" cy="257" r="220" stroke="currentColor" stroke-opacity=".14"/>
    <circle cx="290" cy="257" r="173" stroke="currentColor" stroke-opacity=".1"/>
    <g transform="translate(80 110) rotate(-12 200 140)">
      <rect x="0" y="18" width="405" height="264" rx="9" fill="#152F8C"/>
      <rect width="405" height="264" rx="9" fill="#1A3DB8" stroke="#FFFFFF" stroke-opacity=".65" stroke-width="3"/>
      <path d="M132 0v264M273 0v264M0 132h132M273 132h132" stroke="#FFFFFF" stroke-opacity=".65" stroke-width="2"/>
      <path d="M203 -14v292" stroke="#FFFFFF" stroke-width="5"/>
      <path d="M196 -14v292M210 -14v292" stroke="#FFFFFF" stroke-opacity=".25" stroke-dasharray="3 4" stroke-width="2"/>
    </g>
    <g transform="translate(315 286) rotate(24)">
      <rect x="-10" y="41" width="25" height="100" rx="10" fill="#0D1626" stroke="#FFFFFF" stroke-width="3"/>
      <rect x="-62" y="-64" width="128" height="139" rx="45" fill="#C9F24D" stroke="#0D1626" stroke-width="7"/>
      <path d="M-30 -36h64M-30 -22h64M-30 -8h64M-30 6h64M-30 20h64M-30 34h64" stroke="#335C00" stroke-opacity=".22" stroke-width="3"/>
      <path d="M-5 88h15M-5 98h15M-5 108h15M-5 118h15" stroke="#FFFFFF" stroke-opacity=".4" stroke-width="2"/>
    </g>
    <circle cx="143" cy="152" r="29" fill="#C9F24D"/>
    <g fill="#335C00" fill-opacity=".48"><circle cx="133" cy="143" r="4"/><circle cx="153" cy="145" r="4"/><circle cx="143" cy="161" r="4"/></g>
    <path d="M121 113l-9 -17M107 126l-17 -7M145 110l2 -18" stroke="#C9F24D" stroke-width="3" stroke-linecap="round"/>
    <circle cx="465" cy="330" r="10" fill="#FFFFFF"/>
  </svg>`);
}

function sportCards(facility) {
  return SPORTS.map((s, i) => {
    const a = facility?.activities.find((a) => a.id === s.id);
    const unit = facility?.rules.slotMinutes === 60 ? 'hour' : `${facility?.rules.slotMinutes ?? 60}-min slot`;
    return html`<article class="lp-sport">
      <div class="lp-sport-art lp-sport-art-${i}"><span class="lp-sport-number">0${i + 1} / THE GAME</span>${s.art()}<span class="lp-sport-glyph">${icon(s.icon, 42)}</span></div>
      <div class="lp-sport-body"><div class="lp-sport-title"><h3>${s.label}</h3><span class="lp-small">${a ? `${a.count} ${s.unit}${a.count === 1 ? '' : 's'}` : 'At Le Spinners'}</span></div>
        <p>${s.copy}</p>
        ${a?.count ? html`<div class="lp-rates"><div><span>Members · from</span><strong>${a.priceMemberLabel}<small> / ${unit}</small></strong></div><div><span>Non-members · from</span><strong>${a.priceNonMemberLabel}<small> / ${unit}</small></strong></div></div>` : html`<p class="lp-small">${a ? 'Courts and tables are being prepared.' : 'Current rates are available when facility details load.'}</p>`}
        <a class="lp-text-link" href="${bookHref(`/book/${s.id}`)}">Book a ${s.unit}${icon('arrow-right', 18)}</a>
      </div>
    </article>`;
  });
}

function visitInfo(f) {
  const address = f?.facility.address;
  const hasAddress = address && !address.startsWith('[');
  const directions = facilityDirections(f?.facility);
  return html`<div class="lp-visit-address"><span class="lp-location-icon">${icon('map-pin', 30)}</span><h3>${f?.facility.name || 'Le Spinners Recreational Hub'}</h3><p>${hasAddress ? address : 'Our address will appear here once the facility details are ready.'}</p>
    ${directions ? html`<a class="btn btn-volt btn-md" href="${directions}" target="_blank" rel="noopener noreferrer">Get directions${icon('arrow-right', 18)}</a>` : ''}</div>
    <div class="lp-hours"><h3>${icon('clock', 20)}Regular opening hours</h3>${f?.hours?.length ? html`<dl>${[...f.hours].sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7)).map((h) => html`<div><dt>${h.name}</dt><dd>${h.isOpen ? h.label : 'Closed'}</dd></div>`)}</dl>` : html`<p>Opening hours are temporarily unavailable.</p>`}<p class="lp-small">Schedules can change. Check the Court Calendar for your date.</p></div>`;
}

function publicHeader(page) {
  const consolePath = state.user?.role === 'admin' ? '/admin/' : state.user?.role === 'staff' ? '/staff/' : null;
  const home = state.user?.role === 'player' ? '/welcome' : '/';
  return html`<header class="lp-header"><div class="lp-wrap lp-header-inner">
    <a class="lp-brand" href="${home}" aria-label="Le Spinners home">${logo(42)}<span>Le Spinners<small>RECREATIONAL HUB</small></span></a>
    <nav class="lp-nav" aria-label="Explore Le Spinners"><a href="/sports-rates" ${page === 'sports' ? html`aria-current="page"` : ''}>Sports &amp; rates</a><a href="/court-calendar" ${page === 'calendar' ? html`aria-current="page"` : ''}>Court Calendar</a><a href="${home}#how-it-works">How it works</a><a href="${home}#visit">Visit us</a></nav>
    <a class="btn btn-secondary btn-sm lp-login" href="${consolePath || (state.user ? '/' : '/login')}" ${consolePath ? html`data-native` : ''}>${consolePath ? 'Open console' : state.user ? 'My dashboard' : 'Log in'}${icon('arrow-right', 16)}</a>
  </div></header>`;
}

function publicFooter() {
  const home = state.user?.role === 'player' ? '/welcome' : '/';
  return html`<footer class="lp-footer"><a class="lp-brand" href="${home}" aria-label="Le Spinners home">${logo(36)}<span>Le Spinners<small>RECREATIONAL HUB</small></span></a><p>© Le Spinners Recreational Hub — Since 2026.</p></footer>`;
}

function publicPage(page, title, content) {
  const { scope, show } = viewTools();
  const previousTitle = document.title;
  document.title = title;
  const root = show(html`<div class="lp">${publicHeader(page)}<div class="lp-wrap">${content}${publicFooter()}</div><div class="lp-mobile-book"><a class="btn btn-primary btn-lg" href="${bookHref()}">${icon('calendar-plus', 20)}Book a court or table${icon('arrow-right', 18)}</a></div></div>`).querySelector('.lp');
  const header = root.querySelector('.lp-header');
  const size = new ResizeObserver(() => root.style.setProperty('--lp-header-height', header.offsetHeight + 'px'));
  root.style.setProperty('--lp-header-height', header.offsetHeight + 'px');
  size.observe(header);
  const cleanup = () => { size.disconnect(); document.title = previousTitle; };
  return { root, cleanup: scope ? scope.own(cleanup) : cleanup };
}

export function landingView() {
  const f = state.facility;
  const page = publicPage('home', 'Le Spinners — Pickleball & Table Tennis', html`
<section class="lp-hero" aria-labelledby="lp-title">
        <div class="lp-hero-copy"><p class="lp-eyebrow">A LITTLE COMPETITION. A LOT OF GOOD TIMES.</p><h1 id="lp-title">Your next game<br>starts <em>here.</em></h1>
          <p class="lp-hero-description">Pickleball courts. Table tennis tables.<br>A place to play, rally, and come back for more.</p>
          <a class="btn btn-volt btn-lg" href="${bookHref()}">Book a court or table${icon('arrow-right', 20)}</a>
          <a class="lp-hero-secondary" href="/court-calendar">${icon('calendar', 18)}Explore the Court Calendar</a>
          <p class="lp-hero-welcome">${icon('users', 17)}Members and non-members welcome</p>
        </div>
        <div class="lp-hero-visual">${heroArt()}<span class="lp-art-caption">LESS SCROLLING. MORE RALLYING.</span><div class="lp-art-tag">${icon('paddle', 20)}Pickleball<span>+</span>${icon('pingpong', 20)}Table tennis</div></div>
      </section>
      <div class="lp-intro-strip"><span>${icon('calendar', 19)}Find a time that fits</span><span>${icon('phone', 19)}Pay with GCash</span><span>${icon('chat', 19)}Chat with our team</span></div>
<section class="lp-section" id="how-it-works" aria-labelledby="how-title"><div class="lp-section-heading"><div><p class="lp-eyebrow">FROM “LET’S PLAY” TO GAME ON</p><h2 id="how-title">A few taps. Then a few rallies.</h2></div></div>
        <div class="lp-steps">${[
          ['calendar', 'Find your time', 'Choose a sport, court or table, and your open time slots. Back to back or with a gap — it’s up to you.'],
          ['hourglass', 'Hold your spot', `Reserve your times with a temporary hold${f ? ` of ${f.rules.holdMinutes} minutes` : ''}. Your payment screen shows the countdown.`],
          ['phone', 'Pay & send proof', 'Pay the amount due through GCash, then upload your payment screenshot before the hold ends.'],
          ['check-circle', 'Get ready to play', 'Staff verify your payment and confirm your booking. Show your booking reference when you arrive.'],
        ].map(([ic, title, copy], i) => html`<article class="lp-step"><div class="lp-step-top"><span>${icon(ic, 24)}</span><b>0${i + 1}</b></div><h3>${title}</h3><p>${copy}</p></article>`)}</div>
        <p class="lp-small lp-payment-note">${icon('info', 18)}Payment proof submitted means it is waiting for verification. A GCash booking is confirmed after staff approve it.</p>
      </section>
<section class="lp-section" id="visit" aria-labelledby="visit-title"><div class="lp-section-heading"><div><p class="lp-eyebrow">SEE YOU AT THE HUB</p><h2 id="visit-title">Come for the game. Stay for the fun.</h2></div></div><div class="lp-visit" data-visit>${visitInfo(f)}</div></section>
  `);
  return page.cleanup;
}

export function sportsRatesView() {
  const { api, render } = viewTools();
  const f = state.facility;
  const page = publicPage('sports', 'Sports & Rates — Le Spinners', html`<section class="lp-section" id="sports" aria-labelledby="sports-title"><div class="lp-section-heading"><div><p class="lp-eyebrow">PICK YOUR PLAY</p><h2 id="sports-title">Two sports. Your kind of fun.</h2></div><p>Make time for a match.<br>We’ll help you find the space.</p></div><div class="lp-sports" data-sports>${sportCards(f)}</div><p class="lp-small lp-rate-note">Rates are per court or table. Your total is shown before you reserve. Member rates apply once membership is confirmed.</p></section>`);
  let stopCarousel = wireCarousel(page.root.querySelector('[data-sports]'), { label: 'Sports', loop: true, mobileOnly: true });
  const controller = new AbortController();
  if (!f) api.get('/api/facility', { signal: controller.signal }).then((facility) => {
    if (controller.signal.aborted) return;
    state.facility = facility;
    stopCarousel();
    render(page.root.querySelector('[data-sports]'), sportCards(facility));
    stopCarousel = wireCarousel(page.root.querySelector('[data-sports]'), { label: 'Sports', loop: true, mobileOnly: true });
  }).catch(() => {});
  return () => { controller.abort(); stopCarousel(); page.cleanup(); };
}

export function courtCalendarView() {
  const page = publicPage('calendar', 'Court Calendar — Le Spinners', html`<section class="lp-section lp-calendar-section" id="court-calendar" aria-labelledby="calendar-title">
        <div class="lp-section-heading"><div><p class="lp-eyebrow">MAKE ROOM FOR A GAME</p><h2 id="calendar-title">Court Calendar</h2></div><p>Find an open court or table.<br>No account needed to look around.</p></div>
        <div class="lp-calendar">
          <div class="lp-calendar-controls"><div class="lp-sport-filter" role="group" aria-label="Filter by sport">${SPORTS.map((s) => html`<button type="button" data-sport="${s.id}" aria-pressed="${String(s.id === 'pickleball')}">${icon(s.icon, 17)}${s.label}</button>`)}</div>
            <label class="lp-date-label">Choose date<input class="input" type="date" data-date aria-label="Calendar date" required></label></div>
          <div class="lp-date-nav"><button class="icon-btn" type="button" data-prev aria-label="Previous day">${icon('chevron-left', 20)}</button><div class="lp-date-strip" data-dates></div><button class="icon-btn" type="button" data-next aria-label="Next day">${icon('chevron-right', 20)}</button></div>
          <div class="lp-calendar-meta"><div><h3 data-calendar-heading>Finding your next game…</h3><p class="lp-small" data-window>Checking the booking window…</p></div></div>
          <div class="lp-legend" aria-label="Availability legend">${['available', 'held', 'booked', 'unavailable', 'maintenance', 'open_play', 'closed', 'past'].map((key) => html`<span class="lp-legend-item ${key}">${icon(STATES[key][1], 14)}${STATES[key][0]}</span>`)}</div>
          <div class="lp-calendar-results" data-results aria-busy="true"><p class="lp-calendar-message">Checking availability…</p></div>
          <div class="lp-calendar-foot"><span class="lp-small" data-calendar-status role="status" aria-live="polite">Loading calendar</span><button class="btn btn-text btn-sm" type="button" data-refresh>${icon('refresh', 16)}Refresh</button></div>
        </div>
        <p class="lp-small lp-calendar-note">Select an available time to continue to booking. ${!state.user ? 'Sign in or create an account to reserve. ' : ''}Times are in facility local time. Browsing does not hold a slot.</p>
      </section>`);
  const stopCalendar = wireCalendar(page.root);
  return () => { stopCalendar(); page.cleanup(); };
}

/** Native scroll snapping keeps touch gestures and vertical page scrolling smooth. */
function wireCarousel(track, { label, loop = false, mobileOnly = false }) {
  const { scope, listen, render, setTimeout } = viewTools();
  const cards = [...track.children];
  const media = window.matchMedia('(max-width: 760px)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const controls = document.createElement('div');
  controls.className = `lp-carousel-controls${mobileOnly ? ' lp-carousel-mobile' : ''}`;
  render(controls, html`<button class="icon-btn" type="button" data-back aria-label="Previous ${label}">${icon('chevron-left', 20)}</button><span role="status" aria-live="polite"></span><button class="icon-btn" type="button" data-forward aria-label="Next ${label}">${icon('chevron-right', 20)}</button>`);
  track.after(controls);
  track.setAttribute('role', 'region');
  track.setAttribute('aria-roledescription', 'carousel');
  track.setAttribute('aria-label', label);
  track.tabIndex = 0;
  let clones = [];
  let index = 0;
  let timer;
  let touching = false;
  let active = false;
  const looping = () => active && loop && cards.length > 1;
  const position = (card) => card.getBoundingClientRect().left - track.getBoundingClientRect().left + track.scrollLeft;
  const nearest = () => [...track.children].reduce((best, card, i, all) => Math.abs(position(card) - track.scrollLeft) < Math.abs(position(all[best]) - track.scrollLeft) ? i : best, 0);
  if (!loop) index = nearest();
  function update() {
    controls.hidden = !active || cards.length < 2;
    controls.querySelector('span').textContent = `${index + 1} / ${cards.length} · ${label}`;
    controls.querySelector('[data-back]').disabled = !looping() && track.scrollLeft <= 1;
    controls.querySelector('[data-forward]').disabled = !looping() && track.scrollLeft >= track.scrollWidth - track.clientWidth - 1;
  }
  function jump(card) {
    // Disable snapping during the invisible move from an end clone to its original.
    track.style.scrollSnapType = 'none';
    track.scrollLeft = position(card);
    track.style.scrollSnapType = '';
  }
  function settle() {
    if (!active || touching) return;
    const n = nearest();
    index = looping() ? (n - 1 + cards.length) % cards.length : n;
    if (looping() && (n === 0 || n === cards.length + 1)) jump(cards[index]);
    update();
  }
  function scroll() {
    clearTimeout(timer);
    timer = setTimeout(settle, 160);
  }
  function move(direction, origin = nearest()) {
    if (!active) return;
    const all = [...track.children];
    const target = Math.max(0, Math.min(all.length - 1, origin + direction));
    track.scrollTo({ left: position(all[target]), behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  }
  function click(event) {
    if (event.target.closest('[data-back]')) move(-1);
    if (event.target.closest('[data-forward]')) move(1);
  }
  function key(event) {
    if (event.target !== track || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    move(event.key === 'ArrowRight' ? 1 : -1);
  }
  function setup() {
    clearTimeout(timer);
    clones.forEach((card) => card.remove());
    clones = [];
    active = !mobileOnly || media.matches;
    track.tabIndex = active ? 0 : -1;
    if (looping()) {
      clones = [cards.at(-1).cloneNode(true), cards[0].cloneNode(true)];
      clones.forEach((card) => { card.inert = true; card.setAttribute('aria-hidden', 'true'); card.dataset.clone = ''; });
      track.prepend(clones[0]);
      track.append(clones[1]);
    }
    if (active) jump(cards[index]);
    else track.scrollLeft = 0;
    update();
  }
  let gesture = null;
  const touchStart = (event) => {
    touching = true; clearTimeout(timer);
    const touch = event.touches[0];
    gesture = touch && event.touches.length === 1 ? { x:touch.clientX, y:touch.clientY, origin:nearest() } : null;
  };
  const touchEnd = (event) => {
    touching = false;
    const touch = event.changedTouches[0];
    if (looping() && gesture && touch && event.type === 'touchend') {
      const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
      // Native snapping may exclude inert loop clones. Commit a deliberate
      // horizontal swipe to its adjacent slide, preserving vertical scrolling.
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) move(dx < 0 ? 1 : -1, gesture.origin);
    }
    gesture = null; scroll();
  };
  const listeners = [
    listen(controls, 'click', click),
    listen(track, 'scroll', scroll, { passive: true }),
    listen(track, 'keydown', key),
    listen(track, 'touchstart', touchStart, { passive: true }),
    listen(track, 'touchend', touchEnd, { passive: true }),
    listen(track, 'touchcancel', touchEnd, { passive: true }),
    listen(media, 'change', setup),
  ];
  const resize = new ResizeObserver(() => { if (active && !touching) { jump(cards[index]); update(); } });
  setup();
  resize.observe(track);
  const cleanup = () => {
    clearTimeout(timer);
    resize.disconnect();
    listeners.forEach(off => off());
    clones.forEach((card) => card.remove());
    controls.remove();
  };
  return scope ? scope.own(cleanup) : cleanup;
}

function wireCalendar(root) {
  const { listen, render, api, poll } = viewTools();
  const $ = (selector) => root.querySelector(selector);
  const results = $('[data-results]');
  const dateInput = $('[data-date]');
  const status = $('[data-calendar-status]');
  let facility = state.facility;
  let serverClock = facility ? { now: facility.now, at: performance.now() } : null;
  let date = facility?.today || '';
  let activity = 'pickleball';
  let stopCarousel = () => {};
  let data = null;
  let controller = null;
  let disposed = false;
  let rendered = '';
  let renderedDates = '';

  function dates() {
    if (!facility || !date) return;
    const today = facility.today;
    const last = addDays(today, facility.rules.bookingWindowDays);
    dateInput.min = today;
    dateInput.max = last;
    dateInput.value = date;
    $('[data-prev]').disabled = date <= today;
    $('[data-next]').disabled = date >= last;
    const offset = Math.floor((Date.parse(date) - Date.parse(today)) / 86400000);
    const start = addDays(today, Math.floor(offset / 7) * 7);
    const strip = $('[data-dates]');
    const markup = html`${Array.from({ length: 7 }, (_, i) => addDays(start, i)).filter((d) => d <= last).map((d) => html`<button type="button" data-day="${d}" aria-pressed="${String(d === date)}" aria-label="${dateText(d, { weekday: 'long', month: 'long', day: 'numeric' })}"><span>${d === today ? 'Today' : dateText(d, { weekday: 'short' })}</span><strong>${dateText(d, { day: 'numeric' })}</strong><small>${dateText(d, { month: 'short' })}</small></button>`)}`;
    if (String(markup) !== renderedDates) {
      const focused = strip.contains(document.activeElement) ? document.activeElement.dataset.day : null;
      render(strip, markup);
      renderedDates = String(markup);
      if (focused) strip.querySelector(`[data-day="${focused}"]`)?.focus({ preventScroll: true });
      const selected = strip.querySelector('[aria-pressed="true"]');
      if (selected) strip.scrollLeft += selected.getBoundingClientRect().left - strip.getBoundingClientRect().left - (strip.clientWidth - selected.clientWidth) / 2;
    }
    $('[data-calendar-heading]').textContent = dateText(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    $('[data-window]').textContent = `Browse through ${dateText(last, { month: 'short', day: 'numeric' })} · ${facility.rules.slotMinutes}-minute slots`;
  }

  function draw() {
    if (!data) return;
    const list = data.resources.filter((r) => r.activity === activity);
    const markup = !list.length ? html`<p class="lp-calendar-message">No courts or tables to show for this sport yet. Try another sport.</p>` : !data.open ? html`<p class="lp-calendar-message">${icon('calendar-x', 26)}The facility is closed on this date. Choose another day to play.</p>` : html`<div class="lp-resource-grid">${list.map((r) => {
      const available = r.slots.filter((s) => s.state === 'available').length;
      return html`<article class="lp-resource"><header><span class="lp-resource-icon">${icon(r.activity === 'pickleball' ? 'paddle' : 'pingpong', 22)}</span><div><h4>${r.name}</h4><p>${r.activity === 'pickleball' ? 'Pickleball' : 'Table tennis'}</p></div><span class="lp-open-count">${available} open</span></header><div class="lp-slots">${r.slots.map((s) => {
        const [label, ic] = STATES[s.state] || STATES.unavailable;
        const contents = html`<strong>${s.label} – ${timeText(s.end)}</strong><span>${icon(ic, 13)}${label}</span>`;
        return s.state === 'available' ? html`<a class="lp-slot available" href="${bookHref(`/book/${r.activity}/${date}/${r.id}/${s.start}`)}" aria-label="Book ${r.name}, ${data.dateLabel}, ${s.label} to ${timeText(s.end)}">${contents}</a>` : html`<div class="lp-slot ${s.state}">${contents}</div>`;
      })}</div></article>`;
    })}</div>`;
    // A poll with unchanged results must not remove a keyboard user's focus.
    if (String(markup) !== rendered) {
      const track = results.querySelector('.lp-resource-grid');
      const scroll = track?.scrollLeft || 0;
      const focusedHref = results.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
      stopCarousel();
      render(results, markup);
      rendered = String(markup);
      const nextTrack = results.querySelector('.lp-resource-grid');
      if (nextTrack) {
        nextTrack.scrollLeft = scroll;
        stopCarousel = wireCarousel(nextTrack, { label: activity === 'pickleball' ? 'Pickleball courts' : 'Table tennis tables' });
      }
      if (focusedHref) [...results.querySelectorAll('a')].find((a) => a.getAttribute('href') === focusedHref)?.focus({ preventScroll: true });
    }
  }

  function error(message) {
    stopCarousel();
    data = null;
    rendered = '';
    render(results, html`<div class="lp-calendar-message">${icon('wifi-off', 26)}<strong>Availability is unavailable right now</strong><p>${message}</p><button class="btn btn-secondary btn-md" type="button" data-retry>Try again</button></div>`);
    results.setAttribute('aria-busy', 'false');
    status.textContent = 'Not connected · refresh to check current availability';
  }

  async function load({ clear = false, resynced = false } = {}) {
    controller?.abort();
    const current = controller = new AbortController();
    const signal = current.signal;
    if (navigator.onLine === false) { error('Connect to the internet to see open times.'); return; }
    if (clear) {
      stopCarousel();
      data = null; rendered = '';
      render(results, html`<p class="lp-calendar-message">Checking availability…</p>`);
    }
    results.setAttribute('aria-busy', 'true');
    status.textContent = 'Checking availability…';
    try {
      if (!facility) {
        facility = await api.get('/api/facility', { signal });
        if (disposed || signal.aborted) return;
        state.facility = facility;
        serverClock = { now: facility.now, at: performance.now() };
        date = facility.today;
      }
      // Keep date bounds correct when a tab is left open across facility midnight.
      const today = new Date(serverClock.now + performance.now() - serverClock.at + facility.tzOffsetMinutes * 60000).toISOString().slice(0, 10);
      if (today > facility.today) { facility.today = today; if (date < today) date = today; }
      dates();
      const day = await api.get(`/api/facility/calendar?date=${date}${activity ? `&activity=${activity}` : ''}`, { signal });
      if (disposed || signal.aborted) return;
      data = day;
      serverClock = { now: day.now, at: performance.now() };
      facility.today = day.today;
      facility.rules.bookingWindowDays = Math.round((Date.parse(day.lastDate) - Date.parse(day.today)) / 86400000);
      facility.rules.slotMinutes = day.slotMinutes;
      dates();
      draw();
      results.setAttribute('aria-busy', 'false');
      const t = new Date(day.now + day.tzOffsetMinutes * 60000);
      status.textContent = `Updated ${timeText(t.getUTCHours() * 60 + t.getUTCMinutes())} · refreshes every 30 seconds`;
    } catch (err) {
      if (disposed || signal.aborted) return;
      if (!resynced && ['DATE_PAST', 'OUTSIDE_WINDOW'].includes(err.code)) {
        facility = null;
        await load({ clear: true, resynced: true });
      } else error(err.message || 'Please try again.');
    }
  }

  function chooseDate(value) {
    if (!value || value < dateInput.min || value > dateInput.max || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      dateInput.value = date;
      status.textContent = 'Choose a date within the booking window.';
      return;
    }
    date = value;
    dates();
    load({ clear: true });
  }
  listen(root, 'click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-sport')) {
      activity = button.dataset.sport;
      root.querySelectorAll('[data-sport]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      load({ clear: true });
    } else if (button.dataset.day) chooseDate(button.dataset.day);
    else if (button.hasAttribute('data-prev') && date) chooseDate(addDays(date, -1));
    else if (button.hasAttribute('data-next') && date) chooseDate(addDays(date, 1));
    else if (button.hasAttribute('data-refresh') || button.hasAttribute('data-retry')) load({ clear: true });
  });
  listen(dateInput, 'change', () => chooseDate(dateInput.value));
  const offline = () => { controller?.abort(); error('Connect to the internet to see open times.'); };
  const refresh = () => load();
  const listeners = [listen(window, 'offline', offline), listen(window, 'online', refresh), listen(window, 'focus', refresh)];
  dates();
  load();
  const stopPoll = poll(refresh, 30000);
  return () => { stopCarousel(); disposed = true; controller?.abort(); stopPoll(); listeners.forEach(off => off()); };
}
