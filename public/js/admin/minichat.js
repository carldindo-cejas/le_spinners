import { api } from '../core/api.js';
import { html, on, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { firstName } from '../core/format.js';
import { messageList, openImage } from '../core/chatview.js';
import { poll, skeletonRows, toast } from '../core/ui.js';
import { refreshBadges } from './shell.js';
import { API, BASE } from './console.js';
import { QUICK } from './screens/messages.js';

/**
 * The booking chat as a card that expands in place (booking details, payment review)
 * instead of opening the Messages screen. The element is created once per page and
 * moved into each repaint, so a half-typed reply and the scroll position survive.
 * Opened, it fills the rest of its column (see .chat-card.open in admin.css).
 */
export function miniChat({ bookingId, playerName, unread = 0 }) {
  const el = document.createElement('section');
  el.className = 'panel chat-card';
  el.setAttribute('aria-label', `Booking chat with ${playerName}`);
  let open = false;
  let messages = null;
  let lastKey = '';
  let stop = () => {};
  let unreadCount = unread;
  const first = firstName(playerName);

  render(el, html`<button type="button" class="list-row chat-toggle" aria-expanded="false" aria-controls="mini-chat-${bookingId}" data-toggle>
      <span class="tile blue sm">${icon('chat', 20)}</span>
      <span class="grow"><span class="row-title">Booking chat · ${playerName}</span><br><span class="row-meta" data-meta></span></span>
      <span data-badge></span>${icon('chevron-down', 18, 2.2, 'chev chat-chev')}
    </button>
    <div class="chat-body" id="mini-chat-${bookingId}" hidden>
      <ol class="thread-log mini-log" role="log" aria-live="polite" data-log>${skeletonRows(3)}</ol>
      <div class="mini-compose">
        <div class="quick-replies">${QUICK.map((q) => html`<button type="button" class="chip" data-quick="${q}">${q}</button>`)}</div>
        <form data-form><label class="sr-only" for="mini-reply-${bookingId}">Reply to ${first}</label><textarea id="mini-reply-${bookingId}" class="composer-input" rows="1" maxlength="1000" placeholder="Reply to ${first}…"></textarea><button type="submit" class="send-btn" aria-label="Send">${icon('send', 20, 2.2)}</button></form>
        <p class="small mini-foot">${icon('lock', 13, 2.4)}<span>Private to ${first} &amp; staff · <a href="${BASE}/messages/${bookingId}">Open in Messages</a></span></p>
      </div>
    </div>`);

  const toggle = el.querySelector('[data-toggle]');
  const body = el.querySelector('.chat-body');
  const log = el.querySelector('[data-log]');
  const form = el.querySelector('[data-form]');
  const input = form.querySelector('textarea');

  function paintHead() {
    el.querySelector('[data-meta]').textContent = open
      ? 'Private to the player and staff'
      : unreadCount ? `${unreadCount} unread message${unreadCount === 1 ? '' : 's'} · tap to open` : 'Private to the player and staff · tap to open';
    render(el.querySelector('[data-badge]'), !open && unreadCount ? html`<span class="badge inline">${unreadCount}</span>` : '');
  }

  function paintLog(force = false) {
    const key = `${messages.length}:${messages.at(-1)?.id ?? ''}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    render(log, messages.length
      ? messageList(messages, { side: 'staff' })
      : html`<li class="lock-line center-line">${icon('lock', 14, 2.4)}No messages yet. Say hello to ${first}.</li>`);
    if (force || near) log.scrollTop = log.scrollHeight;
  }

  async function load(first = false) {
    try {
      const res = await api.get(`${API}/bookings/${encodeURIComponent(bookingId)}/messages`);
      messages = res.messages;
      paintLog(first);
      if (first) setTimeout(refreshBadges, 300);
    } catch (err) {
      if (first) render(log, html`<li class="small center-line">${err.message}</li>`);
    }
  }

  function setOpen(next) {
    open = next;
    el.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    // The surrounding layout stretches the column so the open chat ends with the other column.
    el.closest('.cols')?.classList.toggle('cols-chat-open', open);
    stop();
    if (open) {
      unreadCount = 0;
      load(true);
      stop = poll(() => load(false), 10_000);
      input.focus({ preventScroll: true });
    }
    paintHead();
  }

  toggle.addEventListener('click', () => setOpen(!open));
  input.addEventListener('input', () => {
    input.style.setProperty('height', 'auto');
    input.style.setProperty('height', `${Math.min(input.scrollHeight, 120)}px`);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  on(el, 'click', '[data-quick]', (_e, btn) => {
    input.value = btn.dataset.quick;
    input.focus();
  });
  on(el, 'click', '[data-proof]', (_e, btn) => openImage(btn.dataset.proof));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const btn = form.querySelector('.send-btn');
    btn.disabled = true;
    try {
      const res = await api.post(`${API}/bookings/${encodeURIComponent(bookingId)}/messages`, { body: text });
      input.value = '';
      input.style.removeProperty('height');
      messages = res.messages;
      paintLog(true);
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally {
      btn.disabled = false;
      input.focus();
    }
  });
  paintHead();

  return {
    el,
    /**
     * Puts the card into `slot` (a placeholder from the latest repaint). Keeps focus
     * in the reply box if it had it, and the open layout on the new column wrapper.
     */
    mount(slot) {
      if (!slot) return;
      const active = el.contains(document.activeElement) ? document.activeElement : null;
      const caret = active === input ? [input.selectionStart, input.selectionEnd] : null;
      const scroll = log.scrollTop;
      slot.replaceWith(el);
      log.scrollTop = scroll;
      el.closest('.cols')?.classList.toggle('cols-chat-open', open);
      if (active) {
        active.focus({ preventScroll: true });
        if (caret) input.setSelectionRange(caret[0], caret[1]);
      }
    },
    /** Opens the chat (if closed) and brings it into view. */
    show() {
      if (!open) setOpen(true);
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      input.focus({ preventScroll: true });
    },
    setUnread(n) {
      if (!open) {
        unreadCount = n;
        paintHead();
      }
    },
    destroy() {
      stop();
    },
  };
}
