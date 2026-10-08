import { html, listen } from '../core/dom.js';
import { currentScope } from '../core/lifecycle.js';
import { icon } from '../core/icons.js';
import { openModal, statusPill } from '../core/ui.js';
import { BASE } from './console.js';

/**
 * Shows the active bookings a facility change would affect. Staff choose to apply the change and
 * keep the bookings (follow up per booking), or — when the caller supports it — to cancel the
 * bookings with a booking credit first (REBOOKING.md §11). Resolves 'apply', 'disrupt' or false.
 */
function confirmAffected(affected, message, { canDisrupt }) {
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
        <p class="small">${canDisrupt
          ? 'Cancel & credit gives each player back what they paid as booking credit and tells them in the app. Or keep the bookings and follow up one by one.'
          : 'These bookings are kept. Open each one to message the player or cancel it with a booking credit. New bookings can\'t be made in the changed times.'}</p>
        <div class="dialog-actions">
          ${canDisrupt ? html`<button type="button" class="btn btn-danger btn-block" data-act="disrupt">${icon('calendar-x', 18)}Cancel &amp; credit these bookings…</button>` : ''}
          <button type="button" class="btn ${canDisrupt ? 'btn-secondary' : 'btn-primary'} btn-block" data-act="apply">Apply change, keep these bookings</button>
          <button type="button" class="btn btn-secondary btn-block" data-close>Go back</button></div>`,
      onOpen: (panel, m) => {
        listen(panel.querySelector('[data-act="apply"]'), 'click', () => {
          answer = 'apply';
          m.close();
        });
        listen(panel.querySelector('[data-act="disrupt"]'), 'click', () => {
          answer = 'disrupt';
          m.close();
        });
      },
    });
  });
}

/**
 * Runs `send(confirmAffected)` and walks staff through any 409 AFFECTS_BOOKINGS.
 * Returns the response, or null when staff go back. If more bookings appear
 * between the warning and the confirmation, the server asks again.
 *
 * `disrupt(affected)` (optional) offers "Cancel & credit": it resolves
 *   { done: true, result }  the disruption itself made the change (a closure): return `result`
 *   { done: false }         bookings handled; now apply the change itself
 *   null                    staff went back
 */
export async function withImpactCheck(send, { disrupt } = {}) {
  const scope = currentScope();
  let confirmed = [];
  for (;;) {
    scope?.assertCurrent();
    try {
      const result = await send(confirmed);
      scope?.assertCurrent();
      return result;
    } catch (err) {
      if (err.code !== 'AFFECTS_BOOKINGS') throw err;
      const affected = (err.details && err.details.affected) || [];
      const choice = await confirmAffected(affected, err.message, { canDisrupt: Boolean(disrupt) });
      scope?.assertCurrent();
      if (!choice) return null;
      if (choice === 'disrupt') {
        const out = await disrupt(affected);
        scope?.assertCurrent();
        if (!out) return null;
        if (out.done) return out.result;
      }
      confirmed = affected.map((b) => b.id);
    }
  }
}

/** "2 bookings need follow-up" for the success toast. */
export function followUpNote(res) {
  const n = (res && res.affected && res.affected.length) || 0;
  return n ? `${n} booking${n === 1 ? '' : 's'} kept · follow up with ${n === 1 ? 'the player' : 'each player'}` : '';
}

/** Promise wrapper for the disruption dialog: resolves its detail, or null when closed without applying. */
export function disruptionAsPromise(open) {
  return new Promise((resolve) => open((result) => resolve(result || null)));
}
