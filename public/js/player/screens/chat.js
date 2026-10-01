import { api } from '../../core/api.js';
import { $, html, on, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { bookingTime, shortDate } from './util.js';
import { messageList, openImage } from '../../core/chatview.js';
import { errorState, poll, skeletonRows, statusPill, toast } from '../../core/ui.js';
import { refreshBadges, show } from '../shell.js';

export function chatView({ params }) {
  const id = params.id;
  let data = null;
  let lastKey = '';
  const root = show(html`<div class="chat-page">
    <header class="sub-head chat-head" data-head>${skeletonRows(1)}</header>
    <div class="chat-scroll">
      <ol class="chat-log" role="log" aria-live="polite" aria-label="Booking chat" data-log>
        <li class="lock-line center-line">${icon('lock', 14, 2.4)}Private · only you and Le Spinners staff</li>
      </ol>
    </div>
    <form class="composer" data-form>
      <span data-attach></span>
      <label class="sr-only" for="chat-input">Message</label>
      <textarea id="chat-input" class="composer-input" name="body" rows="1" maxlength="1000" placeholder="Type a message…" required></textarea>
      <button type="submit" class="send-btn" aria-label="Send">${icon('send', 20, 2.2)}</button>
    </form>
  </div>`);
  const head = $('[data-head]', root);
  const log = $('[data-log]', root);
  const form = $('[data-form]', root);
  const input = $('#chat-input', root);

  function paintHead() {
    const b = data.booking;
    render(head, html`<div class="sub-head-inner">
      <a class="icon-btn flat" href="/bookings/${b.id}" data-back aria-label="Back to booking">${icon('chevron-left', 22, 2.2)}</a>
      <span class="avatar sm blue" aria-hidden="true">LS</span>
      <div class="grow"><h1 class="t2">Booking chat</h1><div class="t1">${b.resource.name} · ${shortDate(b.date)} · ${bookingTime(b)}</div></div>
      <a class="icon-btn flat" href="/bookings/${b.id}" aria-label="Booking details">${icon('info', 20)}</a>
    </div>
    <a class="chat-context" href="/bookings/${b.id}"><span class="mono">${b.ref}</span>${statusPill(b.status, { small: true })}</a>`);
    render($('[data-attach]', root), b.canSubmitProof ? html`<a class="icon-btn flat" href="/bookings/${b.id}/pay" aria-label="Upload payment screenshot">${icon('plus', 22, 2.2)}</a>` : '');
    head.querySelector('[data-back]').addEventListener('click', (e) => {
      if (history.state && history.state.depth > 0) {
        e.preventDefault();
        history.back();
      }
    });
  }

  function paintLog(force = false) {
    const key = `${data.messages.length}:${data.messages.at(-1)?.id ?? ''}`;
    if (!force && key === lastKey) return;
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
    lastKey = key;
    render(log, html`<li class="lock-line center-line">${icon('lock', 14, 2.4)}Private · only you and Le Spinners staff</li>
      ${data.messages.length ? messageList(data.messages, { side: 'player' }) : html`<li class="small center-line">Say hello — staff usually reply within a few minutes during opening hours.</li>`}`);
    if (force || nearBottom) window.scrollTo(0, document.body.scrollHeight);
  }

  on(log, 'click', '[data-proof]', (_e, btn) => openImage(btn.dataset.proof));

  async function load(first = false) {
    try {
      data = await api.get(`/api/bookings/${encodeURIComponent(id)}/messages`);
      if (first) paintHead();
      paintLog(first);
      if (first) refreshBadges();
    } catch (err) {
      if (!first) return;
      render(log, html`<li>${errorState(err)}</li>`);
      $('[data-act="retry"]', log)?.addEventListener('click', () => load(true));
    }
  }

  input.addEventListener('input', () => {
    input.style.setProperty('height', 'auto');
    input.style.setProperty('height', `${Math.min(input.scrollHeight, 140)}px`);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body || !data) return;
    const btn = form.querySelector('.send-btn');
    btn.disabled = true;
    try {
      const res = await api.post(`/api/bookings/${encodeURIComponent(id)}/messages`, { body });
      input.value = '';
      input.style.removeProperty('height');
      data.messages = res.messages;
      paintLog(true);
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally {
      btn.disabled = false;
      input.focus();
    }
  });

  load(true);
  return poll(() => load(false), 10_000);
}

