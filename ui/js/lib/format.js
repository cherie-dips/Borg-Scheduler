// Text formatting shared by the page and the demos: numbers, times, sentences.
// Pure functions (no DOM) so they can be unit-tested with `node --test`.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Up to `digits` decimals, without trailing zeros: 0.5, 2, 0.25.
export function num(v, digits = 2) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  const s = Number(v).toFixed(digits);
  const t = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  return t === '-0' ? '0' : t;
}

const pad2 = (n) => String(n).padStart(2, '0');

// Local wall-clock time for an epoch in seconds: "14:03:07".
export function clock(epoch) {
  if (!epoch) return '—';
  const d = new Date(epoch * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;

// "web frontend" -> "Web frontend"
export const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

// A server message as a sentence: "no such job" -> "No such job."
export function sentence(s) {
  const t = String(s || 'something went wrong').trim();
  return t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
}
