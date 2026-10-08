import { createViewTools } from '../core/view.js';
import { api } from '../core/api.js';
import { $, html, listen, on, render, setBusy } from '../core/dom.js';
import { openModal, preserveFocus, showFieldErrors, clearFieldErrors, toast } from '../core/ui.js';
import { icon } from '../core/icons.js';

const viewTools = createViewTools({ api, listen, on, render, setBusy, openModal, toast, showFieldErrors, clearFieldErrors });

export function paymentMethodSettings(root, initialMethods, readOnly = false, scope) {
  const tools = viewTools(scope);
  let methods = initialMethods;
  function paint() {
    preserveFocus(root, () => tools.render(root, html`<div class="stack stack-12">
      ${methods.length ? methods.map(method => html`<article class="payment-method-row">
        <div class="stack stack-4 grow"><div class="row row-wrap" data-gap="8"><b>${method.name}</b><span class="pill sm ${method.enabled ? 'green' : 'neutral'}">${method.enabled ? 'Enabled' : 'Disabled'}</span></div>
          ${method.accountName ? html`<span class="small">${method.accountName}</span>` : ''}
          ${method.accountNumber ? html`<span class="small mono">${method.accountNumber}</span>` : ''}
          ${method.hasQr ? html`<span class="meta">QR code configured</span>` : ''}
        </div>
        ${readOnly ? '' : html`<div class="row row-wrap" data-gap="8"><button type="button" class="btn btn-secondary btn-xs" role="switch" aria-checked="${method.enabled ? 'true' : 'false'}" aria-label="${method.name} available for payment" data-toggle-method="${method.id}">${method.enabled ? 'On' : 'Off'}</button><button type="button" class="btn btn-secondary btn-xs" data-edit-method="${method.id}">Edit</button><button type="button" class="btn btn-text btn-xs danger-text" data-archive-method="${method.id}">Archive</button></div>`}
      </article>`) : html`<p class="small">No payment methods configured. Add a method to accept online payments.</p>`}
      ${readOnly ? '' : html`<button type="button" class="btn btn-secondary btn-sm" data-add-method>${icon('plus', 16)}Add payment method</button>`}
    </div>`));
  }
  async function refresh() {
    const data = await tools.api.get('/api/admin/settings');
    methods = data.paymentMethods;
    paint();
  }
  function edit(method = {}) {
    let saving = false;
    let id = method.id;
    let removeQr = false;
    tools.openModal({
      label: id ? 'Edit payment method' : 'Add payment method', locked: () => saving,
      content: () => html`<form class="stack stack-16" novalidate data-method-form>
        <h2 class="h3">${id ? 'Edit payment method' : 'Add payment method'}</h2>
        <div class="field"><label class="label" for="pm-name">Payment Method Name</label><input class="input" id="pm-name" name="name" value="${method.name || ''}" maxlength="80" required placeholder="e.g. GCash, Maya, Bank Transfer"></div>
        ${[['accountName', 'Account Name', method.accountName, 120], ['accountNumber', 'Account Number', method.accountNumber, 100]].map(([key, label, value, max]) => html`<div class="field">
          <div class="row row-between"><label class="label" for="pm-${key}">${label} <span class="opt">(optional)</span></label><button type="button" class="btn btn-text btn-xs" data-detail="${key}">${value ? 'Remove' : 'Add'}</button></div>
          <input class="input" id="pm-${key}" name="${key}" value="${value || ''}" maxlength="${max}" ${value ? '' : html`hidden`}>
        </div>`)}
        <div class="stack stack-8"><span class="label">QR Code <span class="opt">(optional)</span></span>
          ${method.hasQr ? html`<img class="qr-preview" src="${method.qrUrl}" alt="${method.name} QR code" data-method-qr>` : ''}
          <div class="row row-wrap" data-gap="8"><label class="btn btn-secondary btn-xs" for="pm-qr" data-qr-label>${method.hasQr ? 'Replace QR' : 'Add QR'}</label><button type="button" class="btn btn-text btn-xs danger-text" data-remove-qr ${method.hasQr ? '' : html`hidden`}>Remove QR</button></div>
          <input class="sr-only" id="pm-qr" type="file" accept="image/jpeg,image/png,image/webp" data-method-file>
          <p class="help" data-file-name>JPG, PNG or WEBP · up to 5 MB</p>
        </div>
        <label class="row" data-gap="8"><input type="checkbox" name="enabled" ${method.enabled !== false ? html`checked` : ''}>Enabled for bookers</label>
        <p class="field-error" role="alert" data-method-error hidden></p>
        <div class="row row-wrap" data-gap="8"><button type="submit" class="btn btn-primary btn-sm">Save payment method</button><button type="button" class="btn btn-secondary btn-sm" data-close>Cancel</button></div>
      </form>`,
      onOpen(panel, modal) {
        const local = viewTools(modal.scope);
        const form = $('[data-method-form]', panel);
        const input = $('[data-method-file]', panel);
        const error = $('[data-method-error]', panel);
        local.on(panel, 'click', '[data-detail]', (_e, button) => {
          const field = form.elements.namedItem(button.dataset.detail);
          field.hidden = !field.hidden;
          if (field.hidden) field.value = ''; else field.focus();
          button.textContent = field.hidden ? 'Add' : 'Remove';
        });
        local.listen(input, 'change', () => {
          const file = input.files?.[0];
          if (!file) return;
          error.hidden = true;
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size === 0 || file.size > 5 * 1024 * 1024) {
            input.value = ''; error.hidden = false; error.textContent = 'Choose a JPG, PNG or WEBP image up to 5 MB.'; return;
          }
          $('[data-file-name]', panel).textContent = file.name;
          $('[data-remove-qr]', panel).hidden = false;
          $('[data-qr-label]', panel).textContent = 'Replace QR';
          removeQr = false;
        });
        local.listen($('[data-remove-qr]', panel), 'click', () => {
          input.value = ''; removeQr = true;
          $('[data-method-qr]', panel)?.remove();
          $('[data-remove-qr]', panel).hidden = true;
          $('[data-qr-label]', panel).textContent = 'Add QR';
          $('[data-file-name]', panel).textContent = 'JPG, PNG or WEBP · up to 5 MB';
        });
        local.listen(form, 'submit', async event => {
          event.preventDefault();
          if (saving) return;
          local.clearFieldErrors(form); error.hidden = true;
          const payload = { name: form.elements.name.value.trim(), accountName: form.elements.accountName.value.trim() || null,
            accountNumber: form.elements.accountNumber.value.trim() || null, enabled: form.elements.enabled.checked };
          if (!payload.name) return local.showFieldErrors(form, { name: ['Enter a payment method name.'] });
          saving = true;
          const button = $('button[type="submit"]', form);
          local.setBusy(button, true, 'Saving…');
          for (const field of form.elements) if (field !== button) field.disabled = true;
          try {
            if (id) await local.api.put(`/api/admin/payment-methods/${id}`, payload);
            else id = (await local.api.post('/api/admin/payment-methods', payload)).id;
            const file = input.files?.[0];
            if (file) { const data = new FormData(); data.append('file', file, file.name); await local.api.upload(`/api/admin/payment-methods/${id}/qr`, data, { method: 'PUT' }); }
            else if (removeQr && method.hasQr) await local.api.delete(`/api/admin/payment-methods/${id}/qr`);
            await refresh();
            tools.toast('Payment method saved'); modal.close();
          } catch (err) {
            local.showFieldErrors(form, err.details || {});
            error.hidden = false; error.textContent = err.message;
          } finally {
            saving = false; local.setBusy(button, false);
            for (const field of form.elements) field.disabled = false;
          }
        });
      },
    });
  }
  tools.on(root, 'click', '[data-add-method]', () => edit());
  tools.on(root, 'click', '[data-edit-method]', (_e, button) => edit(methods.find(method => method.id === button.dataset.editMethod)));
  tools.on(root, 'click', '[data-toggle-method]', async (_e, button) => {
    if (button.disabled) return;
    const method = methods.find(row => row.id === button.dataset.toggleMethod);
    const enabled = !method.enabled;
    const controls = [...button.closest('.payment-method-row').querySelectorAll('button')];
    for (const control of controls) control.disabled = true;
    tools.setBusy(button, true, 'Saving…');
    try {
      await tools.api.put(`/api/admin/payment-methods/${method.id}`, { name: method.name, accountName: method.accountName, accountNumber: method.accountNumber, enabled });
      await refresh();
      tools.toast(`${method.name} turned ${enabled ? 'on' : 'off'}`, { sub: enabled ? 'Available for payment.' : 'Unavailable for payment.' });
    } catch (err) {
      tools.toast(err.message || 'Payment method could not be updated.', { type: 'error' });
    } finally {
      tools.setBusy(button, false);
      for (const control of controls) control.disabled = false;
    }
  });
  tools.on(root, 'click', '[data-archive-method]', (_e, button) => {
    const method = methods.find(row => row.id === button.dataset.archiveMethod);
    let busy = false;
    tools.openModal({ label: 'Archive payment method?', locked: () => busy,
      content: () => html`<div class="stack stack-16"><h2 class="h3">Archive ${method.name}?</h2><p class="small">This method will leave the active list and payment options. Existing payment records retain their method.</p><p class="field-error" role="alert" data-error hidden></p><div class="row" data-gap="8"><button type="button" class="btn btn-danger btn-sm" data-confirm-archive>Archive</button><button type="button" class="btn btn-secondary btn-sm" data-close>Cancel</button></div></div>`,
      onOpen(panel, modal) {
        const local = viewTools(modal.scope);
        local.listen($('[data-confirm-archive]', panel), 'click', async () => {
          if (busy) return; busy = true;
          const button = $('[data-confirm-archive]', panel); local.setBusy(button, true, 'Archiving…');
          try { await local.api.delete(`/api/admin/payment-methods/${method.id}`); await refresh(); tools.toast('Payment method archived'); modal.close(); }
          catch (err) { const error = $('[data-error]', panel); error.hidden = false; error.textContent = err.message; }
          finally { busy = false; local.setBusy(button, false); }
        });
      },
    });
  });
  paint();
}
