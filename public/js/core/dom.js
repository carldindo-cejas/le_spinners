import { currentScope, elementScope, isAbort, setElementScope } from './lifecycle.js';
/**
 * Tiny, safe templating. Every interpolated value is HTML-escaped unless it is
 * itself the result of `html` (or `raw`, reserved for app-made markup such as
 * icons). User data can never become markup.
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"'`]/g, (c) => ESC[c]);
}

class SafeHtml {
  constructor(markup) {
    this.markup = markup;
  }
  toString() {
    return this.markup;
  }
}

/** Trusted, app-generated markup only (icons, static SVG). Never pass user data. */
export const raw = (markup) => new SafeHtml(String(markup));

function toMarkup(value) {
  if (value == null || value === false || value === true) return '';
  if (value instanceof SafeHtml) return value.markup;
  if (Array.isArray(value)) return value.map(toMarkup).join('');
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += toMarkup(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Only same-site paths (or https URLs) may become links. */
export function safeUrl(url) {
  if (typeof url !== 'string') return '#';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  if (/^https:\/\//i.test(url)) return url;
  return '#';
}

/**
 * The CSP forbids inline style attributes, so dynamic values are passed as
 * data-css="--p:0.4; --w:40%" and applied through the CSSOM after render.
 */
export function applyDynamic(root) {
  for (const el of root.querySelectorAll('[data-css]')) {
    for (const part of el.getAttribute('data-css').split(';')) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      const name = part.slice(0, i).trim();
      const value = part.slice(i + 1).trim();
      if (/^--[\w-]+$/.test(name) && /^[-\w.%#(), ]*$/.test(value)) el.style.setProperty(name, value);
    }
  }
}

export function render(el, template) {
  el.innerHTML = toMarkup(template);
  applyDynamic(el);
  return el;
}

/** Separate route content from the stable shell element and its next view. */
export function mount(el, template) {
  const root = document.createElement('div');
  root.className = 'route-mount';
  if (currentScope()) setElementScope(root, currentScope());
  render(root, template);
  el.replaceChildren(root);
  currentScope()?.own(() => root.remove());
  return root;
}

export function fragment(template) {
  const t = document.createElement('template');
  t.innerHTML = toMarkup(template);
  applyDynamic(t.content);
  return t.content;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Event delegation: handler(event, matchedElement). Returns an unsubscribe function. */
export function on(root, type, selector, handler, options) {
  const listener = (event) => {
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    if (target && root.contains(target)) return handler(event, target);
  };
  return listen(root, type, listener, options);
}

/** Element listeners inherit their mount/dialog lifetime; global view listeners use the active route. */
export function listen(root, type, handler, options) {
  if (!root) return () => {};
  const scope = elementScope(root);
  if (scope && !scope.isCurrent()) return () => {};
  const listener = (...args) => {
    if (scope && !scope.isCurrent()) return;
    try {
      const result = handler(...args);
      if (result?.catch) result.catch(error => { if (!isAbort(error)) console.error(error); });
      return result;
    } catch (error) { if (!isAbort(error)) console.error(error); }
  };
  root.addEventListener(type, listener, options);
  const off = () => root.removeEventListener(type, listener, options);
  return scope ? scope.own(off) : off;
}

export function setBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="spinner${button.classList.contains('btn-secondary') ? ' dark' : ''}" aria-hidden="true"></span>${escapeHtml(busyLabel ?? 'Working…')}`;
  } else {
    if (button.dataset.label != null) button.innerHTML = button.dataset.label;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}
