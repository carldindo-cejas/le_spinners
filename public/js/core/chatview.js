import { html } from './dom.js';
import { icon } from './icons.js';
import { clock, dayClock, initials, isoDate } from './format.js';
import { openModal } from './ui.js';

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
  openModal({
    label: title,
    wide: true,
    content: () => html`<div class="sheet-head"><h2 class="h3">${title}</h2><button type="button" class="icon-btn sm flat" data-close aria-label="Close">${icon('x', 18, 2.2)}</button></div>
      <img class="proof-full" src="${url}" alt="${title}">
      <p class="lock-line">${icon('lock', 16, 2.2)}<span>Private · only the player and Le Spinners staff can see it.</span></p>`,
  });
}
