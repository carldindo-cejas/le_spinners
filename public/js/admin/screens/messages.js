import { historyPager } from '../../core/history.js';
import { createViewTools } from '../../core/view.js';
import { api } from '../../core/api.js';
import { listen, $, html, on, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { bookingTime, firstName, initials, relTime, shortDate } from '../../core/format.js';
import { MESSAGE_MAX_CHARS, charCounter, messageList, openImage } from '../../core/chatview.js';
import { errorState, poll, skeletonRows, statusPill, toast } from '../../core/ui.js';
import { frame, refreshBadges } from '../shell.js';
import { API, BASE } from '../console.js';

const viewTools = createViewTools({ listen, api, on, render, openImage, poll, toast, frame, refreshBadges });

export const QUICK = ['Verifying now — a few minutes.', 'Please upload a clearer screenshot.', 'Please send your GCash reference no.'];
const STATUS_WORD = {
  PAYMENT_SUBMITTED: ['verifying', 'w-violet'],
  TEMPORARY: ['on hold', 'w-amber'],
  REJECTED: ['proof rejected', 'w-amber'],
  CONFIRMED: ['confirmed', 'w-green'],
};

function convRow(c, activeId) {
  const w = STATUS_WORD[c.status];
  return html`<a class="conv${c.unread ? ' unread' : ''}" href="${BASE}/messages/${c.bookingId}" ${c.bookingId === activeId ? html`aria-current="page"` : ''}>
    <span class="avatar sm${c.unread ? '' : ' muted-av'}">${initials(c.userName)}</span>
    <span class="grow stack stack-4">
      <span class="row row-between"><span class="c-name">${c.userName}</span><span class="c-time">${relTime(c.last.at)}</span></span>
      <span class="c-ctx">${c.activity === 'table_tennis' ? 'Table Tennis' : 'Pickleball'} — ${c.resourceName} · ${c.dateLabel.split(', ')[1] || c.dateLabel}${w ? html` · <span class="${w[1]}">${w[0]}</span>` : ''}</span>
      <span class="row row-between" data-gap="8"><span class="c-prev">${c.last.sender === 'staff' ? 'You: ' : ''}${c.last.body}</span>${c.unread ? html`<span class="badge inline">${c.unread}</span>` : ''}</span>
    </span>
  </a>`;
}

export function messagesView({ params }) {
  const { listen, frame, render, on, openImage, api, toast, setTimeout, refreshBadges, poll } = viewTools();
  const activeId = params.id || null;
  let filter = 'all';
  let conversations = null;
  let thread = null;
  let detail = null;
  let lastKey = '';
  const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;

  const root = frame({
    key: 'messages',
    title: 'Messages',
    mobileHeader: activeId ? null : undefined,
    tabs: !activeId,
    template: html`<div class="inbox${activeId ? '' : ' no-context'}" data-inbox>
      <section class="inbox-list${activeId ? ' only-desktop' : ''}" aria-label="Conversations">
        <div class="il-head">
          <label class="search-pill">${icon('search', 18)}<input type="search" placeholder="Name or booking reference" aria-label="Search conversations" data-search></label>
          <div class="chip-row" role="group" aria-label="Filter" data-filters></div>
        </div>
        <div data-convs>${skeletonRows(5)}</div>
        <p class="small pad-16">Each conversation belongs to one booking. Only that player and Le Spinners staff can read it.</p>
      </section>
      ${activeId ? html`<section class="thread" aria-label="Conversation" data-thread>${skeletonRows(4)}</section><aside class="ctx-col" data-ctx>${skeletonRows(3)}</aside>`
        : html`<section class="thread only-desktop"><div class="empty empty-center"><span class="tile blue lg">${icon('chat', 26)}</span><p class="empty-title">Pick a conversation</p><p class="empty-body">Every booking has its own private thread with the player.</p></div></section>`}
    </div>`,
  });
  const convsEl = $('[data-convs]', root);
  const threadEl = activeId ? $('[data-thread]', root) : null;
  const listPages = historyPager(api, convsEl.parentElement, loadList, {label:'Conversations'});
  let search = '';
  let searchTimer;

  function paintList() {
    render($('[data-filters]', root), [
      html`<button type="button" class="chip" data-filter="unread" aria-pressed="${String(filter === 'unread')}">Unread</button>`,
      html`<button type="button" class="chip" data-filter="all" aria-pressed="${String(filter === 'all')}">All</button>`,
      html`<button type="button" class="chip violet" data-filter="verifying" aria-pressed="${String(filter === 'verifying')}">Verifying</button>`,
    ]);
    const items = conversations;
    render(convsEl, items.length ? items.map((c) => convRow(c, activeId)) : html`<div class="pad-16"><p class="strong">${filter === 'unread' ? 'All caught up' : 'No conversations'}</p><p class="small">${filter === 'unread' ? 'No unread messages right now.' : 'Messages from players show up here.'}</p></div>`);
  }

  function paintThread(force = false) {
    const b = thread.booking;
    const key = `${thread.messages.length}:${thread.messages.at(-1)?.id ?? ''}`;
    const threadEl = $('[data-thread]', root);
    if (!threadEl.querySelector('[data-log]')) {
      render(threadEl, html`<header class="thread-head">
          <a class="icon-btn flat only-mobile" href="${BASE}/messages" aria-label="Back to messages">${icon('chevron-left', 22, 2.2)}</a>
          <span class="avatar">${initials(b.user.name)}</span>
          <div class="grow"><p class="strong">${b.user.name}</p><p class="small row" data-gap="6">${icon('lock', 13, 2.4)}<span class="mono">${b.ref}</span> · private to ${firstName(b.user.name)} &amp; staff</p></div>
        </header>
        <div class="thread-strip"><span class="small strong">${b.resource.name} · ${shortDate(b.date)} · ${bookingTime(b)}</span>${statusPill(b.status, { small: true })}${b.status === 'PAYMENT_SUBMITTED' ? html`<a class="btn btn-secondary btn-xs ml-auto" href="${BASE}/verify/${b.id}">Review payment</a>` : ''}</div>
        <ol class="thread-log" role="log" aria-live="polite" data-log></ol>
        <div class="thread-compose">
          <div class="quick-replies">${QUICK.map((q) => html`<button type="button" class="chip" data-quick="${q}">${q}</button>`)}</div>
          <form data-form><label class="sr-only" for="reply">Reply</label><textarea id="reply" class="composer-input" rows="1" maxlength="${MESSAGE_MAX_CHARS}" placeholder="Reply to ${firstName(b.user.name)}…"></textarea><button type="submit" class="send-btn" aria-label="Send">${icon('send', 20, 2.2)}</button></form>
        </div>`);
      wireComposer(threadEl);
      force = true;
    }
    if (!force && key === lastKey) return;
    lastKey = key;
    const log = threadEl.querySelector('[data-log]');
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
    render(log, html`<li class="lock-line center-line">${icon('lock', 14, 2.4)}Private to ${b.user.name} &amp; Le Spinners staff</li>${messageList(thread.messages, { side: 'staff' })}`);
    if (force || near) {
      const last = log.lastElementChild;
      if (last) last.scrollIntoView({ block: 'end' });
    }
  }

  function paintContext() {
    const el = $('[data-ctx]', root);
    if (!el || !detail) return;
    const b = detail.booking;
    const p = detail.proofs[0];
    render(el, html`<p class="eyebrow">This booking</p>
      <p class="h3">${b.resource.name}</p>
      <p class="small">${b.activityLabel} · ${shortDate(b.date)} · ${bookingTime(b)}</p>
      <div>${statusPill(b.status, { small: true })}</div>
      <dl class="kv">
        <div><dt>Amount</dt><dd class="mono">${b.amountLabel}</dd></div>
        <div><dt>Claimed</dt><dd class="${p && p.amountCheck === 'match' ? 'green-text' : p && p.amountCheck === 'differs' ? 'red-text' : ''}">${p && p.amountClaimedLabel ? `${p.amountClaimedLabel} · ${p.amountCheck === 'match' ? 'matches' : 'differs'}` : '—'}</dd></div>
        <div><dt>GCash ref.</dt><dd class="mono">${p && p.gcashRef ? p.gcashRef : '—'}</dd></div>
        <div><dt>Customer</dt><dd>${b.user.membership === 'member' ? 'Member' : 'Non-member'}</dd></div>
      </dl>
      ${b.status === 'PAYMENT_SUBMITTED' ? html`<a class="btn btn-violet btn-block" href="${BASE}/verify/${b.id}">Review payment</a>` : ''}
      <a class="btn btn-secondary btn-block" href="${BASE}/bookings/${b.id}">View booking</a>
      <p class="small">Each conversation belongs to one booking. A player with three bookings has three separate threads.</p>`);
  }

  function wireComposer(threadEl) {
    const form = threadEl.querySelector('[data-form]');
    const input = threadEl.querySelector('#reply');
    const syncCount = charCounter(input);
    listen(input, 'input', () => {
      input.style.setProperty('height', 'auto');
      input.style.setProperty('height', `${Math.min(input.scrollHeight, 140)}px`);
    });
    listen(input, 'keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    on(threadEl, 'click', '[data-quick]', (_e, btn) => {
      input.value = btn.dataset.quick;
      syncCount();
      input.focus();
    });
    on(threadEl, 'click', '[data-proof]', (_e, btn) => openImage(btn.dataset.proof));
    listen(form, 'submit', async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      const btn = form.querySelector('.send-btn');
      btn.disabled = true;
      try {
        const res = await api.post(`${API}/bookings/${encodeURIComponent(activeId)}/messages`, { body });
        input.value = '';
        input.style.removeProperty('height');
        syncCount();
        threadPages.reset();
        await loadThread(true);
        loadList();
      } catch (err) {
        toast(err.message, { type: 'error' });
      } finally {
        btn.disabled = false;
        input.focus();
      }
    });
  }

  on(root, 'click', '[data-filter]', (_e, btn) => {
    filter = btn.dataset.filter;
    listPages.reset();
    loadList();
  });
  on(root, 'input', '[data-search]', (_e, el) => {
    search = el.value.trim();
    clearTimeout(searchTimer);
    listPages.reset();
    searchTimer = setTimeout(loadList, 250);
  });

  async function loadList() {
    try {
      const res = await listPages.get(`${API}/messages?filter=${filter}&q=${encodeURIComponent(search)}`);
      conversations = res.conversations;
      paintList();
    } catch (err) {
      if (!conversations) {
        render(convsEl, errorState(err));
        listen($('[data-act="retry"]', convsEl), 'click', loadList);
      }
    }
  }

  const threadPages = activeId ? historyPager(api, threadEl, () => loadThread(false), {label:'Earlier messages'}) : null;
  async function loadThread(first = false) {
    if (!activeId) return;
    try {
      const [t, d] = await Promise.all([
        threadPages.get(`${API}/bookings/${encodeURIComponent(activeId)}/messages`),
        first || !detail ? api.get(`${API}/bookings/${encodeURIComponent(activeId)}`) : Promise.resolve(detail),
      ]);
      thread = t;
      detail = d;
      paintThread(first);
      threadPages.mount();
      if (first) paintContext();
      if (first) setTimeout(refreshBadges, 300);
    } catch (err) {
      const el = $('[data-thread]', root);
      if (first) {
        render(el, html`<div class="pad-16">${errorState(err, { retry: err.status !== 404, title: err.status === 404 ? 'Conversation not found' : undefined })}</div>`);
        listen($('[data-act="retry"]', el), 'click', () => loadThread(true));
      }
    }
  }

  if (!activeId || isDesktop()) loadList();
  loadThread(true);
  const stop = poll(async () => {
    if (!activeId || isDesktop()) await loadList();
    await loadThread(false);
  }, 10_000);
  return stop;
}
