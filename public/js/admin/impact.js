import { html } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { openModal, statusPill } from '../core/ui.js';
import { BASE } from './console.js';

/**
 * Shows the active bookings a facility change would affect and resolves true only
 * when staff confirm. Nothing is cancelled: bookings stay as they are, and staff
 * follow up from each booking (chat, or cancel with a reason).
 */
function confirmAffected(affected, message) {
  return new Promise((resolve) => {
    let answer = false;
    openModal({
      wide: true,
      role: 'alertdialog',
      label: 'This change affects bookings',
      onClose: () => resolve(answer),
      content: () => html`<span class="tile amber">${icon('alert', 24)}</span>
        <h2 class="dialog-title">This change affects ${affected.length} booking${affected.length === 1 ? '' : 's'}</h2>
        <p class="body">${message}</p>
        <ul class="impact-list">${affected.map((b) => html`<li><a href="${BASE}/bookings/${b.id}" target="_blank" rel="noopener"><span class="mono">${b.ref}</span><span class="grow"><span class="strong">${b.resourceName} · ${b.dateLabel} · ${b.timeLabel}</span><br><span class="small">${b.userName}</span></span>${statusPill(b.status, { small: true })}</a></li>`)}</ul>
        <p class="small">These bookings are kept. Open each one to message the player or cancel it with a reason. New bookings can't be made in the changed times.</p>
        <div class="dialog-actions"><button type="button" class="btn btn-primary btn-block" data-act="apply">Apply change, keep these bookings</button><button type="button" class="btn btn-secondary btn-block" data-close>Go back</button></div>`,
      onOpen: (panel, m) => panel.querySelector('[data-act="apply"]').addEventListener('click', () => {
        answer = true;
        m.close();
      }),
    });
  });
}

/**
 * Runs `send(confirmAffected)` and walks staff through any 409 AFFECTS_BOOKINGS.
 * Returns the response, or null when staff go back. If more bookings appear
 * between the warning and the confirmation, the server asks again.
 */
export async function withImpactCheck(send) {
  let confirmed = [];
  for (;;) {
    try {
      return await send(confirmed);
    } catch (err) {
      if (err.code !== 'AFFECTS_BOOKINGS') throw err;
      const affected = (err.details && err.details.affected) || [];
      if (!(await confirmAffected(affected, err.message))) return null;
      confirmed = affected.map((b) => b.id);
    }
  }
}

/** "2 bookings need follow-up" for the success toast. */
export function followUpNote(res) {
  const n = (res && res.affected && res.affected.length) || 0;
  return n ? `${n} booking${n === 1 ? '' : 's'} kept · follow up with ${n === 1 ? 'the player' : 'each player'}` : '';
}