// Small DOM helpers. Views render HTML strings; `patch` only touches the DOM when the markup
// actually changed, so focus, hover and scroll positions survive the 1 Hz refresh.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function patch(el, html) {
  if (el && el.__html !== html) {
    el.__html = html;
    el.innerHTML = html;
  }
}

export function h(tag, attrs = {}, html = '') {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  if (html) el.innerHTML = html;
  return el;
}

// Width of one character cell in px, measured once per font change.
let chPx = 0;
export function charWidth() {
  if (!chPx) {
    const probe = h('span', { class: 'probe', 'aria-hidden': 'true' }, '0'.repeat(100));
    document.body.appendChild(probe);
    chPx = probe.getBoundingClientRect().width / 100 || 8.4;
    probe.remove();
  }
  return chPx;
}
export const resetCharWidth = () => { chPx = 0; };

// How many character cells fit in an element's content box.
export function cols(el, fallback = 40) {
  if (!el) return fallback;
  const style = getComputedStyle(el);
  const w = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return w > 0 ? Math.floor(w / charWidth()) : fallback;
}

// Keeps Tab focus inside a dialog; returns a function that undoes it.
export function trapFocus(root) {
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', root)
      .filter((x) => !x.disabled && x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  root.addEventListener('keydown', onKey);
  return () => root.removeEventListener('keydown', onKey);
}

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
