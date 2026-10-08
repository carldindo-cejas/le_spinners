import { html, listen } from './dom.js';
import { icon } from './icons.js';
import { advanceAuth } from './lifecycle.js';
import { getLogout } from './logout.js';
import { clearSessionMessages } from './ui.js';

/** One application subscription per portal; it also clears a restored BFCache page. */
export function installLogout({ state, loginPath, clear }) {
  const manager = getLogout();
  let hiddenFor = null;
  manager.subscribe(record => {
    if (!record) return;
    if (hiddenFor !== record.id || state.user) {
      hiddenFor = record.id;
      if (state.user) state.user = null; else advanceAuth();
      clear();
      clearSessionMessages();
      for (const id of ['topnav', 'tabbar', 'sidebar', 'topbar']) document.getElementById(id)?.replaceChildren();
      try { sessionStorage.removeItem('ls_rebook'); } catch { /* storage denied */ }
    }
    if (state.router) state.router.navigate(loginPath, { replace: true });
  });
  return manager;
}

/** Pending intent blocks sign-in and private screens across navigation/reload. */
export function logoutBoundary(show) {
  const manager = getLogout();
  if (!manager.blocked()) return false;
  const busy = manager.busy;
  const root = show(html`<div class="screen center-screen" data-logout-status>
    <span class="tile blue">${icon('lock', 26)}</span>
    <h1 class="h2">${busy ? 'Signing out' : 'Sign-out not confirmed'}</h1>
    <p class="body" role="status">Private screens are hidden. Your server session may still be active.
      ${busy ? 'Waiting for the server to confirm.' : 'Retry when connected to finish signing out.'}</p>
    ${!manager.persisted ? html`<p class="banner warn">This browser could not save the sign-out status. Keep this page open and retry before leaving.</p>`
      : !manager.sharedStorage ? html`<p class="banner warn">Sign-out status is saved only in this tab. Finish signing out before closing it or opening another tab.</p>` : ''}
    <button type="button" class="btn btn-primary btn-lg" data-logout-retry ${busy ? 'disabled' : ''}>${busy ? 'Signing out...' : 'Retry sign-out'}</button>
  </div>`);
  listen(root.querySelector('[data-logout-retry]'), 'click', () => manager.start());
  return true;
}

export function logoutNotice() {
  return getLogout().read()?.phase === 'confirmed'
    ? html`<p class="banner success" role="status" data-logout-confirmed>Signed out on this browser. The server confirmed your sign-out.</p>` : '';
}
