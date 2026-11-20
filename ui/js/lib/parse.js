// Parsing for the command line: tokens, key=value arguments, durations, times, priorities, sizes.
// Pure functions; every parser returns {value} or {error} with a message a beginner can act on.

// Splits on whitespace, keeping "quoted strings" together. Returns tokens with their positions,
// so autocomplete knows which token the cursor is in.
export function tokenize(input) {
  const tokens = [];
  const re = /"([^"]*)"?|'([^']*)'?|(\S+)/g;
  let m;
  while ((m = re.exec(input))) {
    tokens.push({ text: m[1] ?? m[2] ?? m[3], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

// Splits tokens into positional arguments, key=value options and flags (-y, --yes).
export function splitArgs(tokens) {
  const positional = [], options = {}, flags = new Set();
  for (const t of tokens) {
    const s = t.text;
    if (/^--?[a-z][\w-]*$/i.test(s)) flags.add(s.replace(/^--?/, '').toLowerCase());
    else if (/^[a-z_][\w.-]*=/i.test(s)) {
      const i = s.indexOf('=');
      options[s.slice(0, i).toLowerCase()] = s.slice(i + 1);
    } else positional.push(s);
  }
  return { positional, options, flags };
}

// "90", "90s", "5m", "1h30m", "2h" -> seconds
export function parseDuration(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (!t) return { error: 'missing duration' };
  if (/^\d+(\.\d+)?$/.test(t)) return { value: Number(t) };
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs|hr|h|minutes?|mins|min|m|seconds?|secs|sec|s)/g; // longest first
  let total = 0, consumed = '', m;
  while ((m = re.exec(t))) {
    const n = Number(m[1]), u = m[2][0];
    total += u === 'h' ? n * 3600 : u === 'm' ? n * 60 : n;
    consumed += m[0];
  }
  if (!consumed || consumed.replace(/\s/g, '') !== t.replace(/\s/g, '')) {
    return { error: `"${s}" is not a duration: try 30s, 5m or 1h30m` };
  }
  return { value: total };
}

// When to start: "now", "in 5m", "5m", "+90", "at 14:30", "14:30" -> {delay} in seconds (0 = now).
// `now` is a Date (injectable for tests).
export function parseWhen(words, now = new Date()) {
  const t = (Array.isArray(words) ? words.join(' ') : String(words ?? '')).trim().toLowerCase();
  if (!t || t === 'now' || t === 'asap') return { value: 0 };
  const at = t.match(/^(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (at) {
    const [h, m, sec] = [Number(at[1]), Number(at[2]), Number(at[3] ?? 0)];
    if (h > 23 || m > 59 || sec > 59) return { error: `"${t}" is not a valid time of day` };
    const target = new Date(now);
    target.setHours(h, m, sec, 0);
    if (target <= now) target.setDate(target.getDate() + 1); // next occurrence
    return { value: Math.round((target - now) / 1000) };
  }
  const rel = t.replace(/^in\s+/, '').replace(/^\+/, '');
  const d = parseDuration(rel);
  if (d.error) return { error: `"${t}" is not a start time: try now, in 30s, in 5m or at 14:30` };
  return { value: d.value };
}

export const BANDS = { free: 0, batch: 100, prod: 200, production: 200, monitoring: 300, mon: 300 };

// 0..999 or a band name -> number
export function parsePriority(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (t in BANDS) return { value: BANDS[t] };
  if (/^\d+$/.test(t) && Number(t) <= 999) return { value: Number(t) };
  return { error: `priority "${s}" must be 0-999 or one of free, batch, prod, monitoring` };
}

export function bandOf(priority) {
  if (priority >= 300) return 'monitoring';
  if (priority >= 200) return 'production';
  if (priority >= 100) return 'batch';
  return 'free';
}

// "128", "128m", "128mb", "1g", "1.5gb" -> MB
export function parseSize(s) {
  const m = String(s ?? '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|mb|mib|g|gb|gib)?$/);
  if (!m) return { error: `"${s}" is not a size: try 128 (MB) or 1g` };
  const v = Number(m[1]) * (m[2] && m[2][0] === 'g' ? 1024 : 1);
  return v >= 1 ? { value: Math.round(v) } : { error: 'memory must be at least 1 MB' };
}

export function parseNumber(s, { min = -Infinity, max = Infinity, name = 'value', integer = false } = {}) {
  const t = String(s ?? '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { error: `${name} must be a number` };
  const v = Number(t);
  if (integer && !Number.isInteger(v)) return { error: `${name} must be a whole number` };
  if (v < min || v > max) return { error: `${name} must be between ${min} and ${max}` };
  return { value: v };
}

export function parseBool(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (['1', 'y', 'yes', 'true', 'on'].includes(t)) return { value: true };
  if (['0', 'n', 'no', 'false', 'off'].includes(t)) return { value: false };
  return { error: `"${s}" must be yes or no` };
}

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
