// Toasts (top right) for things that happen on their own: completions, failures, machines
// going down. Also announced to screen readers. Clicking one runs its action.

import { esc, clock } from '../lib/format.js';
import { h } from '../lib/dom.js';

let box = null;

export function announce(text) {
  const live = document.getElementById('announcer');
  if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 30);
}

export function toast(level, text, onClick) {
  if (!box) {
    box = h('div', { class: 'toasts', role: 'region', 'aria-label': 'notifications' }); // spoken via the announcer
    document.body.append(box);
  }
  const glyph = { ok: '✓', err: '✗', info: '▸' }[level] || '▸';
  const el = h('button', { type: 'button', class: `toast ${level}` },
    `<span class="${level}">${glyph}</span> ${esc(text)} <span class="tt">· ${clock(Date.now() / 1000)}${onClick ? ' · click for details' : ''}</span>`);
  el.addEventListener('click', () => {
    el.remove();
    onClick?.();
  });
  box.prepend(el);
  while (box.children.length > 4) box.lastChild.remove();
  setTimeout(() => el.remove(), level === 'err' ? 9000 : 6000);
  announce(text);
}
