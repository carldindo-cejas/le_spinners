import { createViewTools } from '../../core/view.js';
import { openChangePassword, openEditProfile } from '../../core/account.js';
import { $, html, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { initials } from '../../core/format.js';
import { frame, state } from '../shell.js';
import { CONSOLE } from '../console.js';

const viewTools = createViewTools({ openChangePassword, openEditProfile, on, frame });

/** The signed-in staff member's or admin's own account. Roles are assigned by an administrator, never here. */
export function profileView() {
  const { frame, on, openEditProfile, openChangePassword } = viewTools();
  const u = state.user;
  const main = frame({
    key: 'profile',
    eyebrow: 'Account',
    title: 'My profile',
    template: html`<div class="page" data-page><div class="cols c-160-1">
      <section class="panel panel-body stack stack-16">
        <div class="row" data-gap="14"><span class="avatar volt lg">${initials(u.name)}</span><div><p class="h3 row" data-gap="8">${u.name}${u.role === 'admin' ? html`<span class="tag sm member">Admin</span>` : html`<span class="tag sm nonmember">Staff</span>`}</p><p class="small">${u.email}</p></div></div>
        <dl class="vq-details">
          <div><dt>Role</dt><dd>${CONSOLE.roleLabel}</dd></div>
          <div><dt>Mobile</dt><dd>${u.phone || '—'}</dd></div>
        </dl>
        <nav class="menu" aria-label="Account">
          <button type="button" class="list-row" data-act="edit"><span class="row-tile">${icon('user', 20)}</span><span class="grow row-title">Personal information</span>${icon('chevron-right', 18, 2.2, 'chev')}</button>
          <button type="button" class="list-row" data-act="password"><span class="row-tile">${icon('lock', 20)}</span><span class="grow row-title">Change password</span>${icon('chevron-right', 18, 2.2, 'chev')}</button>
        </nav>
        <button type="button" class="btn btn-secondary btn-block logout-btn" data-act="logout">${icon('logout', 20)}Log out</button>
      </section>
      <aside class="panel panel-body stack stack-12">
        <p class="eyebrow">Your session</p>
        <p class="small">Console sessions end 12 hours after sign-in or when you log out. Changing your password signs out your other devices.</p>
        <p class="small">Your role and email are set by an administrator. Every sign-in, approval, rejection and facility change is logged with your name.</p>
      </aside>
    </div></div>`,
  });
  const root = $('[data-page]', main);
  on(root, 'click', '[data-act="edit"]', () => openEditProfile(state.user, {
    phoneHelp: 'So the team can reach you. Never shown to players.',
    onSaved: (user) => {
      state.user = user;
      state.router.refresh();
    },
  }));
  on(root, 'click', '[data-act="password"]', () => openChangePassword(state.user.email, { minLength: 12 }));
  return undefined;
}
