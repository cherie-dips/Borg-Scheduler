// Text formatting for a character-cell UI: numbers, times, text progress bars, sparklines.
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

export const int = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));

export function pct(a, b) {
  return b > 0 ? clamp((100 * a) / b, 0, 100) : 0;
}

// "1h 02m", "3m 07s", "42s"
export function dur(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}

// "just now", "12s ago", "3m ago", "2h ago"
export function ago(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

const pad2 = (n) => String(n).padStart(2, '0');

// Local wall-clock time for an epoch in seconds: "14:03:07".
export function clock(epoch) {
  if (!epoch) return '—';
  const d = new Date(epoch * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

// A text progress bar `width` cells wide, with 1/8-cell precision: "█████▌░░░░".
export function bar(fraction, width, empty = '░') {
  const f = clamp(Number.isFinite(fraction) ? fraction : 0, 0, 1);
  const eighths = Math.round(f * width * 8);
  const full = Math.floor(eighths / 8), part = eighths % 8;
  const filled = '█'.repeat(full) + EIGHTHS[part];
  return filled + empty.repeat(Math.max(0, width - full - (part ? 1 : 0)));
}

// Splits `width` cells between segments [{frac, cls}] (fractions of the whole) so the cells add
// up exactly; returns [{cells, cls}]. Used for multi-colour bars (prod / non-prod, done / failed).
export function segments(parts, width) {
  const out = [];
  let used = 0, acc = 0;
  for (const p of parts) {
    acc += clamp(p.frac, 0, 1);
    const end = Math.min(width, Math.round(clamp(acc, 0, 1) * width));
    const cells = Math.max(0, end - used);
    out.push({ cells, cls: p.cls });
    used += cells;
  }
  return { parts: out, rest: Math.max(0, width - used) };
}

const SPARK = '▁▂▃▄▅▆▇█';

// Sparkline of values scaled to [0, max]: "▁▂▄▇█▆▃".
export function spark(values, width, max) {
  const vs = values.slice(-width);
  const top = max ?? Math.max(1e-9, ...vs);
  const line = vs.map((v) => (v == null ? ' ' : SPARK[clamp(Math.round((v / top) * 7), 0, 7)])).join('');
  return line.padStart(width, ' ');
}

// Quadrant spinner (the bundled font has no braille glyphs).
export const SPINNER = ['▖', '▘', '▝', '▗'];
export const spinner = (frame) => SPINNER[((frame % 4) + 4) % 4];

// Fit text to `width` columns, with an ellipsis when cut.
export function fit(s, width) {
  s = String(s ?? '');
  if (width <= 0) return '';
  return s.length <= width ? s.padEnd(width) : s.slice(0, Math.max(0, width - 1)) + '…';
}

export const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
