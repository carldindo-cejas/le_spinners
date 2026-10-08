import { createViewTools } from './view.js';
import { listen, html } from './dom.js';
import { icon } from './icons.js';
import { clock, dayClock, initials, isoDate } from './format.js';
import { openModal } from './ui.js';

const viewTools = createViewTools({ listen, openModal });

/** Per typed chat message. The server enforces the same limit (src/worker/lib/chat.ts). */
export const MESSAGE_MAX_CHARS = 120;

/**
 * Adds a live "n/120" line under a chat composer's textarea. At the limit the count
 * turns red, maxlength stops further typing, and screen readers hear it once.
 * Call the returned function after changing the text in code (quick reply, sent).
 */
export function charCounter(input) {
  const { listen } = viewTools();
  const el = document.createElement('p');
  el.className = 'char-count';
  el.id = `${input.id}-count`;
  const count = document.createElement('span');
  const status = document.createElement('span');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  el.append(count, status);
  input.after(el);
  input.setAttribute('aria-describedby', el.id);
  let full = false;
  const sync = () => {
    const n = input.value.length;
    count.textContent = `${n}/${MESSAGE_MAX_CHARS}`;
    if (full !== (n >= MESSAGE_MAX_CHARS)) {
      full = !full;
      el.classList.toggle('at-limit', full);
      status.textContent = full ? `Limit reached: messages can be up to ${MESSAGE_MAX_CHARS} characters.` : '';
    }
  };
  listen(input, 'input', sync);
  sync();
  return sync;
}

/** Colour for a system line in the booking chat. */
export function systemTint(body) {
  const t = body.toLowerCase();
  if (t.includes('rejected')) return 'red';
  if (t.includes('verified') || t.includes('confirmed')) return 'green';
  if (t.includes('proof submitted')) return 'violet';
  if (t.includes('temporary') || t.includes('created')) return 'amber';
  return 'neutral';
}

function stamp(ms) {
  return isoDate(ms) === isoDate(Date.now()) ? clock(ms) : dayClock(ms);
}

/**
 * Chat bubbles. `side` is who is reading: the player sees their own messages
 * on the right; staff see every staff message on the right.
 */
export function messageList(messages, { side }) {
  return messages.map((m) => {
    if (m.kind === 'system') return html`<li class="msg-system ${systemTint(m.body)}">${m.body} · ${stamp(m.createdAt)}</li>`;
    const mine = side === 'player' ? m.sender === 'player' : m.sender === 'staff';
    const avatar = m.sender === 'staff'
      ? html`<span class="avatar xs blue" aria-hidden="true">LS</span>`
      : html`<span class="avatar xs" aria-hidden="true">${initials(m.senderName || '?')}</span>`;
    const meta = side === 'player' && mine ? stamp(m.createdAt) : `${m.senderName || ''} · ${stamp(m.createdAt)}`;
    if (m.kind === 'proof' && m.proof) {
      return html`<li class="msg ${mine ? 'mine' : 'theirs'}">${mine ? '' : avatar}
        <div class="msg-col"><button type="button" class="bubble attach" data-proof="${m.proof.url}">
          <img src="${m.proof.url}" alt="" loading="lazy">
          <span><span class="strong">Payment screenshot</span><br><span class="att-sub">${icon('lock', 12, 2.4)}Submitted for payment verification</span></span>
        </button><span class="msg-meta">${meta}</span></div></li>`;
    }
    return html`<li class="msg ${mine ? 'mine' : 'theirs'}">${mine ? '' : avatar}<div class="msg-col"><div class="bubble">${m.body}</div><span class="msg-meta">${meta}</span></div></li>`;
  });
}

export function openImage(url, title = 'Payment screenshot') {
  const { openModal } = viewTools();
  openModal({
    label: title,
    wide: true,
    content: () => html`<div class="sheet-head"><h2 class="h3">${title}</h2><button type="button" class="icon-btn sm flat" data-close aria-label="Close">${icon('x', 18, 2.2)}</button></div>
      <img class="proof-full" src="${url}" alt="${title}">
      <p class="lock-line">${icon('lock', 16, 2.2)}<span>Private · only the player and Le Spinners staff can see it.</span></p>`,
  });
}
