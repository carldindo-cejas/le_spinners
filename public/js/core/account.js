import { createViewTools } from './view.js';
/** Account dialogs shared by the player app and the staff/admin consoles. */
import { api } from './api.js';
import { newPasswordCredentials, passwordProof } from './credentials.js';
import { listen, $, html, setBusy } from './dom.js';
import { icon } from './icons.js';
import { clearFieldErrors, openModal, showFieldErrors, toast } from './ui.js';

const viewTools = createViewTools({ listen, api, setBusy, clearFieldErrors, openModal, showFieldErrors, toast });

const localDigits = (phone) => (phone || '').replace(/\D/g, '').replace(/^63(?=9\d{9}$)/, '').replace(/^0/, '');

/** Name and mobile number. `onSaved(user)` gets the updated account. */
export function openEditProfile(user, { onSaved, phoneHelp = 'For booking updates. Never shown to other players.' }) {
  const { listen, openModal, clearFieldErrors, showFieldErrors, setBusy, api, toast } = viewTools();
  const digits = localDigits(user.phone);
  const m = openModal({
    sheet: true,
    label: 'Personal information',
    content: () => html`<div class="sheet-head"><h2 class="h3">Personal information</h2><button type="button" class="icon-btn sm flat" data-close aria-label="Close">${icon('x', 18, 2.2)}</button></div>
      <form class="stack stack-16" novalidate data-form>
        <div class="field"><label class="label" for="p-name">Full name</label><input class="input" id="p-name" name="name" value="${user.name}" maxlength="80" autocomplete="name"></div>
        <div class="field"><label class="label" for="p-phone">Mobile number</label><div class="input-group"><span class="prefix">+63</span><input class="input" id="p-phone" name="phone" type="tel" inputmode="tel" value="${digits}" maxlength="14" autocomplete="tel-national" placeholder="917 123 4567"></div><p class="help">${phoneHelp}</p></div>
        <div class="field"><span class="label">Email</span><p class="body">${user.email}</p></div>
        <button type="submit" class="btn btn-primary btn-lg btn-block">Save changes</button>
      </form>`,
    onOpen: (panel) => {
      const form = $('[data-form]', panel);
      listen(form, 'submit', async (e) => {
        e.preventDefault();
        clearFieldErrors(form);
        const name = form.elements.namedItem('name').value.trim();
        const d = localDigits(form.elements.namedItem('phone').value);
        const errors = {};
        if (name.length < 2) errors.name = ['Enter your full name.'];
        if (d && !/^9\d{9}$/.test(d)) errors.phone = ['Enter a 10-digit mobile number, like 917 123 4567.'];
        if (Object.keys(errors).length) return showFieldErrors(form, errors);
        const btn = form.querySelector('[type="submit"]');
        setBusy(btn, true, 'Saving…');
        try {
          const res = await api.patch('/api/me', { name, phone: d ? `+63 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : '' }, { signal: m.signal });
          m.close();
          toast('Profile updated');
          onSaved(res.user);
        } catch (err) {
          if (err.name === 'AbortError') return;
          setBusy(btn, false);
          if (!showFieldErrors(form, err.details)) toast(err.message, { type: 'error' });
        }
      });
    },
  });
}

/**
 * Password change. Both PBKDF2 derivations run on this device; only their outputs
 * are sent. Players need 8+ characters, staff and admins 12+ (the server never
 * sees the password, so the length rule lives here and in create-admin).
 */
export function openChangePassword(email, { minLength = 8 } = {}) {
  const { listen, openModal, clearFieldErrors, showFieldErrors, setBusy, api, toast } = viewTools();
  const m = openModal({
    sheet: true,
    label: 'Change password',
    content: () => html`<div class="sheet-head"><h2 class="h3">Change password</h2><button type="button" class="icon-btn sm flat" data-close aria-label="Close">${icon('x', 18, 2.2)}</button></div>
      <form class="stack stack-16" novalidate data-form>
        <div class="field"><label class="label" for="pw-cur">Current password</label><input class="input" id="pw-cur" name="currentPassword" type="password" autocomplete="current-password" maxlength="128"></div>
        <div class="field"><label class="label" for="pw-new">New password</label><input class="input" id="pw-new" name="newPassword" type="password" autocomplete="new-password" minlength="${minLength}" maxlength="128"><p class="help">At least ${minLength} characters. You'll stay signed in here; other devices are signed out.</p></div>
        <button type="submit" class="btn btn-primary btn-lg btn-block">Change password</button>
      </form>`,
    onOpen: (panel) => {
      const form = $('[data-form]', panel);
      listen(form, 'submit', async (e) => {
        e.preventDefault();
        clearFieldErrors(form);
        const currentPassword = form.elements.namedItem('currentPassword').value;
        const newPassword = form.elements.namedItem('newPassword').value;
        if (!currentPassword) return showFieldErrors(form, { currentPassword: ['Enter your current password.'] });
        if (newPassword.length < minLength) return showFieldErrors(form, { newPassword: [`Use at least ${minLength} characters.`] });
        const btn = form.querySelector('[type="submit"]');
        setBusy(btn, true, 'Saving…');
        try {
          const [currentClientHash, credentials] = await Promise.all([passwordProof(email, currentPassword, { signal: m.signal }), newPasswordCredentials(newPassword)]);
          if (!m.isOpen()) return;
          await api.post('/api/me/password', { currentClientHash, newPassword: credentials }, { signal: m.signal });
          m.close();
          toast('Password changed', { sub: 'Other devices were signed out.' });
        } catch (err) {
          if (err.name === 'AbortError') return;
          setBusy(btn, false);
          if (!showFieldErrors(form, err.details)) toast(err.message, { type: 'error' });
        }
      });
    },
  });
}
