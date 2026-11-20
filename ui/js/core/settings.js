// User preferences: theme, CRT effects, keys, boot. Kept in localStorage when available
// (it can be blocked, so every access is guarded) and applied to <html> as attributes.

export const THEMES = {
  mono: 'black and white, green = success, red = error (default)',
  borg: 'phosphor green on black',
  amber: 'amber monochrome terminal',
  cobalt: 'cool cyan on deep blue',
  paper: 'light: dark ink on paper',
};
export const EFFECTS = {
  scanlines: 'faint horizontal CRT lines',
  glow: 'soft phosphor glow on text',
  flicker: 'very slight brightness flicker',
  crt: 'rounded screen corners and vignette',
};
export const BOOT = { full: 'animated boot screen', quick: 'short boot screen', off: 'skip the boot screen' };

const KEY = 'mini-borg.settings.v2'; // v2: black-and-white became the default theme
// letterKeys: single-character shortcuts (WCAG 2.1.4 asks for a way to turn them off).
// safeMode: read-only UI, every change to the cluster is refused (for demos).
const DEFAULTS = { theme: 'mono', scanlines: true, glow: true, flicker: false, crt: false, letterKeys: true, safeMode: false, boot: 'full' };

let current = { ...DEFAULTS };
const listeners = new Set();

export function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    current = { ...DEFAULTS, ...saved };
    if (!(current.theme in THEMES)) current.theme = DEFAULTS.theme;
    if (!(current.boot in BOOT)) current.boot = DEFAULTS.boot;
  } catch {
    current = { ...DEFAULTS };
  }
  apply();
  return current;
}

export const get = () => current;

export function set(patch) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage blocked: settings last until reload */
  }
  apply();
  for (const fn of listeners) fn(current);
}

export const reset = () => set({ ...DEFAULTS });
export const onChange = (fn) => listeners.add(fn);

function apply() {
  const root = document.documentElement;
  root.dataset.theme = current.theme;
  for (const fx of Object.keys(EFFECTS)) root.classList.toggle(`fx-${fx}`, !!current[fx]);
}
