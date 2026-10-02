import { api } from '../../core/api.js';
import { $, html, on, render } from '../../core/dom.js';
import { icon, emptyArt } from '../../core/icons.js';
import { errorState, poll, skeletonRows } from '../../core/ui.js';
import { show } from '../shell.js';
import { bookingCard, startCardCountdowns } from '../components.js';

const TABS = ['upcoming', 'past', 'cancelled'];

function split(bookings, now) {
  const upcoming = [];
  const past = [];
  const cancelled = [];
  for (const b of bookings) {
    if (b.status === 'CANCELLED') cancelled.push(b);
    else if ((b.status === 'TEMPORARY' || b.status === 'REJECTED') && b.canSubmitProof) upcoming.push(b);
    else if ((b.status === 'PAYMENT_SUBMITTED' || b.status === 'CONFIRMED') && b.startsAt + 3_600_000 > now) upcoming.push(b);
    else past.push(b);
  }
  upcoming.sort((a, b) => a.startsAt - b.startsAt);
  return { upcoming, past, cancelled };
}

const EMPTY = {
  upcoming: { title: 'No upcoming bookings', body: 'Courts and tables open 14 days ahead. Book a slot and it shows up here with its status.' },
  past: { title: 'No past games yet', body: 'Finished bookings land here with their reference numbers, so you can find them later.' },
  cancelled: { title: 'Nothing cancelled', body: 'Holds you release, and bookings Le Spinners has to cancel, show up here.' },
};

function emptyState(tab) {
  const e = EMPTY[tab];
  return html`<div class="empty">
    ${emptyArt()}
    <p class="empty-title">${e.title}</p>
    <p class="empty-body">${e.body}</p>
    ${tab === 'upcoming' ? html`<a class="btn btn-primary btn-md" href="/book">Book a court or table ${icon('arrow-right', 18, 2.4)}</a>` : ''}
  </div>
  ${tab === 'upcoming' ? html`<section class="card card-pad-lg stack stack-12">
    <p class="overline">How booking works</p>
    <ol class="steps-list">
      <li><span class="n amber">1</span><span>Pick a time. We hold it for 10 minutes.</span></li>
      <li><span class="n blue">2</span><span>Pay by GCash and upload the screenshot.</span></li>
      <li><span class="n violet">3</span><span>Staff check your payment.</span></li>
      <li><span class="n green">4</span><span>Your booking is confirmed.</span></li>
    </ol>
  </section>` : ''}`;
}

export function bookingsView({ query }) {
  let tab = TABS.includes(query.get('tab')) ? query.get('tab') : 'upcoming';
  let data = null;
  let stopCountdowns = () => {};
  const root = show(html`<div class="screen has-tabbar screen-enter">
    <div class="page-title-row"><h1 class="h1">My bookings</h1><a class="btn btn-primary btn-sm" href="/book">${icon('plus', 18, 2.4)}Book</a></div>
    <div data-credit></div>
    <div class="seg" role="tablist" aria-label="Bookings" data-tabs></div>
    <div class="stack stack-12" role="tabpanel" data-list>${skeletonRows(3, 'sk-card')}</div>
  </div>`, { tab: 'bookings', nav: true });
  const tabsEl = $('[data-tabs]', root);
  const list = $('[data-list]', root);

  function paint() {
    const groups = split(data.bookings, data.now);
    const credit = data.credits;
    render($('[data-credit]', root), credit && credit.available > 0
      ? html`<a class="banner info compact" href="/credits">${icon('gift', 18, 2.2)}<span class="grow">You have <b class="mono">${credit.availableLabel}</b> booking credit · it pays for your next booking</span>${icon('chevron-right', 18, 2.2)}</a>`
      : '');
    render(tabsEl, TABS.map((t) => html`<button type="button" role="tab" data-tab="${t}" aria-selected="${t === tab ? 'true' : 'false'}">${t === 'upcoming' ? `Upcoming${groups.upcoming.length ? ` · ${groups.upcoming.length}` : ''}` : t === 'past' ? 'Past' : 'Cancelled'}</button>`));
    stopCountdowns();
    const items = groups[tab];
    if (!items.length) {
      render(list, emptyState(tab));
      return;
    }
    if (tab === 'upcoming') {
      const action = items.filter((b) => b.status === 'TEMPORARY' || b.status === 'REJECTED');
      const rest = items.filter((b) => !action.includes(b));
      render(list, html`${action.length ? html`<p class="overline amber">Action needed</p>${action.map(bookingCard)}` : ''}
        ${rest.length ? html`<p class="overline">Coming up</p>${rest.map(bookingCard)}` : ''}`);
      stopCountdowns = startCardCountdowns(list, data.now, () => setTimeout(load, 1500));
    } else {
      render(list, html`${items.map(bookingCard)}${tab === 'cancelled' ? html`<p class="small center">Bookings can't be cancelled in the app: ask in a booking's chat if your plans change.</p>` : ''}`);
    }
  }

  on(tabsEl, 'click', '[data-tab]', (_e, btn) => {
    tab = btn.dataset.tab;
    history.replaceState(history.state, '', tab === 'upcoming' ? '/bookings' : `/bookings?tab=${tab}`);
    paint();
  });

  async function load() {
    try {
      data = await api.get('/api/bookings');
      paint();
    } catch (err) {
      if (data) return;
      render(list, errorState(err));
      $('[data-act="retry"]', list)?.addEventListener('click', load);
    }
  }
  load();
  const stopPoll = poll(load, 20_000);
  return () => {
    stopPoll();
    stopCountdowns();
  };
}
