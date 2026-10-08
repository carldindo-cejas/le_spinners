import { createViewTools } from '../../core/view.js';
import { api } from '../../core/api.js';
import { listen, $, html, on, render, setBusy } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { TZ } from '../../core/format.js';
import { historyPager } from '../../core/history.js';
import { newPasswordCredentials, normalizeEmail, passwordProof } from '../../core/credentials.js';
import { clearFieldErrors, errorState, openModal, showFieldErrors, skeletonRows, toast } from '../../core/ui.js';
import { frame, state } from '../shell.js';

const ENDPOINT = '/api/admin/staff';
const viewTools = createViewTools({ listen, api, on, render, setBusy, clearFieldErrors, openModal, showFieldErrors, toast, frame });
const createdDate = new Intl.DateTimeFormat('en-PH', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric' });
const stamp = account => ({ expectedAuthVersion: account.authVersion, expectedUpdatedAt: account.updatedAt });
const value = (form, name) => form.elements.namedItem(name).value;
function validate(errors) {
  if (Object.keys(errors).length) throw Object.assign(new Error('Please check the highlighted fields.'), { details: errors });
}
function statusPill(account) {
  return html`<span class="pill ${account.status === 'active' ? 'green' : 'neutral'} sm">${icon(account.status === 'active' ? 'check-circle' : 'minus-circle', 12)}${account.status === 'active' ? 'Active' : 'Inactive'}</span>`;
}
function actions(account) {
  return html`<div class="row row-wrap staff-actions" data-gap="8">
    <button type="button" class="btn btn-secondary btn-xs" data-edit="${account.id}">${icon('edit', 15)}Edit</button>
    <button type="button" class="btn ${account.status === 'active' ? 'btn-danger-outline' : 'btn-secondary'} btn-xs" data-status="${account.id}">${account.status === 'active' ? 'Deactivate' : 'Activate'}</button>
    <button type="button" class="btn btn-secondary btn-xs" data-reset="${account.id}">${icon('lock', 15)}Reset password</button>
  </div>`;
}
function passwordFields() {
  return html`<div class="field"><label class="label" for="staff-password">Password</label><input class="input" id="staff-password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128"><p class="help">Use 12–128 characters.</p></div>
    <div class="field"><label class="label" for="staff-confirm">Confirm password</label><input class="input" id="staff-confirm" name="confirmPassword" type="password" autocomplete="new-password" maxlength="128"></div>`;
}
function passwordErrors(form) {
  const password = value(form, 'password'), errors = {};
  if (password.length < 12 || password.length > 128) errors.password = ['Use 12–128 characters.'];
  if (password !== value(form, 'confirmPassword') || !value(form, 'confirmPassword')) errors.confirmPassword = ['Passwords must match.'];
  return errors;
}

/** All sensitive forms share the same busy lock, cancellation and field errors. */
function formDialog({ title, fields, submitLabel, success, action, onSaved }) {
  const { listen, api, openModal, setBusy, clearFieldErrors, showFieldErrors, toast } = viewTools();
  let busy = false;
  const m = openModal({ sheet: true, label: title, locked: () => busy,
    content: () => html`<div class="sheet-head"><h2 class="h3">${title}</h2><button type="button" class="icon-btn sm flat" data-close aria-label="Close">${icon('x', 18)}</button></div>
      <form class="stack stack-16" novalidate data-form>${fields}<button type="submit" class="btn btn-primary btn-lg btn-block">${submitLabel}</button></form>`,
    onOpen(panel) {
      const form = $('[data-form]', panel), button = form.querySelector('[type="submit"]');
      listen(form, 'submit', async event => {
        event.preventDefault(); if (busy) return;
        clearFieldErrors(form); busy = true; setBusy(button, true, 'Saving…');
        try {
          await action(form, api, m);
          if (!m.isOpen()) return;
          form.reset(); busy = false; m.close(); toast(success); onSaved();
        } catch (error) {
          busy = false; if (error.name === 'AbortError') return;
          setBusy(button, false);
          if (error.code === 'ACCOUNT_CHANGED') { m.close(); onSaved(); }
          if (!showFieldErrors(form, error.details)) toast(error.message, { type: 'error' });
        }
      });
    },
  });
}
function accountDialog(account, onSaved) {
  formDialog({ title: account ? 'Edit staff' : 'Add Staff', submitLabel: account ? 'Save changes' : 'Add Staff',
    success: account ? 'Staff account updated' : 'Staff account created', onSaved,
    fields: html`<div class="field"><label class="label" for="staff-name">Full name</label><input class="input" id="staff-name" name="name" value="${account?.name || ''}" maxlength="80" autocomplete="name" autofocus></div>
      <div class="field"><label class="label" for="staff-email">Email</label><input class="input" id="staff-email" name="email" type="email" value="${account?.email || ''}" maxlength="254" autocomplete="off" autocapitalize="none" spellcheck="false"></div>
      ${account ? html`<p class="help">Changing the email signs this staff member out on every device.</p>` : passwordFields()}
      ${account ? '' : html`<div class="field"><label class="label" for="staff-status">Account status</label><select class="select" id="staff-status" name="status"><option value="active">Active</option><option value="disabled">Inactive</option></select><p class="help">Inactive accounts cannot sign in.</p></div>`}
      <p class="small">Role: Staff</p>`,
    async action(form, api, m) {
      const name = value(form, 'name').trim(), email = normalizeEmail(value(form, 'email'));
      const errors = account ? {} : passwordErrors(form);
      if (name.length < 2 || name.length > 80) errors.name = ['Use 2–80 characters for the full name.'];
      if (!email || form.elements.namedItem('email').validity.typeMismatch) errors.email = ['Enter a valid email address.'];
      validate(errors);
      if (account) {
        const body = { ...stamp(account) };
        if (name !== account.name) body.name = name;
        if (email !== account.email) body.email = email;
        if (Object.keys(body).length > 2) await api.patch(`${ENDPOINT}/${encodeURIComponent(account.id)}`, body, { signal: m.signal });
      } else {
        const password = await newPasswordCredentials(value(form, 'password'));
        if (!m.isOpen()) return;
        await api.post(ENDPOINT, { name, email, password, status: value(form, 'status') }, { signal: m.signal });
      }
    },
  });
}
function statusDialog(account, onSaved) {
  const active = account.status === 'active';
  formDialog({ title: `${active ? 'Deactivate' : 'Activate'} ${account.name}?`, submitLabel: active ? 'Deactivate' : 'Activate',
    success: active ? 'Staff account deactivated' : 'Staff account activated', onSaved,
    fields: html`<p class="body">${active ? 'This account will lose access immediately and be signed out on every device.' : 'This account can sign in again with its existing password. It must start a new session.'}</p><button type="button" class="btn btn-secondary btn-md" data-close>Cancel</button>`,
    action: (_form, api, m) => api.patch(`${ENDPOINT}/${encodeURIComponent(account.id)}`, { ...stamp(account), status: active ? 'disabled' : 'active' }, { signal: m.signal }),
  });
}
function resetDialog(account, onSaved) {
  formDialog({ title: 'Reset staff password', submitLabel: 'Reset password', success: 'Staff password reset; all staff sessions ended', onSaved,
    fields: html`<p class="body">Set a new password for ${account.name}. All their existing sessions will end.${account.status === 'disabled' ? ' This account will remain inactive.' : ''}</p>${passwordFields()}
      <div class="field"><label class="label" for="staff-admin-password">Your administrator password</label><input class="input" id="staff-admin-password" name="currentPassword" type="password" autocomplete="current-password" maxlength="128"></div>`,
    async action(form, api, m) {
      const errors = passwordErrors(form);
      if (!value(form, 'currentPassword')) errors.currentPassword = ['Enter your administrator password.'];
      validate(errors);
      const [newPassword, currentClientHash] = await Promise.all([
        newPasswordCredentials(value(form, 'password')),
        passwordProof(state.user.email, value(form, 'currentPassword'), { signal: m.signal }),
      ]);
      if (!m.isOpen()) return;
      await api.post(`${ENDPOINT}/${encodeURIComponent(account.id)}/reset-password`, { ...stamp(account), newPassword, currentClientHash }, { signal: m.signal });
    },
  });
}

export function staffView({ query }) {
  const { listen, api, on, render, frame, setTimeout } = viewTools();
  let search = query.get('q') || '', status = ['active', 'disabled'].includes(query.get('status')) ? query.get('status') : '';
  let accounts = [], timer;
  const root = frame({ key: 'staff', eyebrow: 'Admin', title: 'Staff Management',
    actions: html`<button type="button" class="btn btn-primary btn-sm only-desktop" data-add>${icon('plus', 18)}Add Staff</button>`,
    template: html`<div class="page" data-staff-page>
      <div class="row row-wrap staff-toolbar" data-gap="12"><label class="search-pill grow">${icon('search', 18)}<input type="search" data-search aria-label="Search staff accounts" placeholder="Search name or email" value="${search}" maxlength="254"></label>
        <select class="select" data-status-filter aria-label="Account status"><option value="">All accounts</option><option value="active">Active</option><option value="disabled">Inactive</option></select>
        <button type="button" class="btn btn-primary btn-sm only-mobile" data-add>${icon('plus', 18)}Add Staff</button></div>
      <div data-list>${skeletonRows(4)}</div><div data-pagination></div>
    </div>` });
  const page = $('[data-staff-page]', root), list = $('[data-list]', page);
  const pages = historyPager(api, $('[data-pagination]', page), load, { label: 'Staff accounts' });
  $('[data-status-filter]', page).value = status;
  async function load() {
    const filters = new URLSearchParams({ q: search, limit: '25' }); if (status) filters.set('status', status);
    try {
      const data = await pages.get(`${ENDPOINT}?${filters}`); accounts = data.staff;
      if (!accounts.length) {
        render(list, html`<div class="empty"><span class="tile blue lg">${icon('users', 26)}</span><p class="empty-title">${search || status ? 'No staff accounts match' : 'No staff accounts yet'}</p><p class="empty-body">${search || status ? 'Change the search or account status filter.' : 'Use Add Staff to create the first account.'}</p></div>`);
        return;
      }
      render(list, html`<div class="table-wrap only-desktop"><table class="grid staff-table" aria-label="Staff accounts"><thead><tr><th scope="col">Full name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Actions</th></tr></thead><tbody>${accounts.map(account => html`<tr><td class="strong">${account.name}</td><td>${account.email}</td><td>Staff</td><td>${statusPill(account)}</td><td><time datetime="${new Date(account.createdAt).toISOString()}">${createdDate.format(account.createdAt)}</time></td><td>${actions(account)}</td></tr>`)}</tbody></table></div>
        <div class="stack stack-12 only-mobile">${accounts.map(account => html`<article class="panel panel-body stack stack-12 staff-card"><div class="row row-between" data-gap="8"><h2 class="h3">${account.name}</h2>${statusPill(account)}</div><p class="body staff-email">${account.email}</p><p class="small">Staff · Created ${createdDate.format(account.createdAt)}</p>${actions(account)}</article>`)}</div>`);
    } catch (error) {
      if (error.name === 'AbortError') return;
      accounts = []; render(list, errorState(error));
    }
  }
  const refresh = () => { pages.reset(); render(list, skeletonRows(4)); load(); };
  const add = () => accountDialog(null, refresh);
  on(page, 'click', '[data-add]', add); on(document.getElementById('topbar'), 'click', '[data-add]', add);
  for (const [attribute, dialog] of [['edit', accountDialog], ['status', statusDialog], ['reset', resetDialog]]) {
    on(page, 'click', `[data-${attribute}]`, (_event, button) => {
      const account = accounts.find(item => item.id === button.getAttribute(`data-${attribute}`));
      if (account) dialog(account, refresh);
    });
  }
  listen($('[data-search]', page), 'input', event => {
    search = event.target.value.trim(); pages.reset(); clearTimeout(timer); timer = setTimeout(refresh, 300);
  });
  listen($('[data-status-filter]', page), 'change', event => { status = event.target.value; refresh(); });
  on(page, 'click', '[data-act="retry"]', refresh);
  load();
}
