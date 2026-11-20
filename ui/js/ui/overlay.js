// Dialogs: a generic framed dialog with a focus trap, plus confirm ([y/N]), choose (radio list),
// the help overlay and the settings panel. Esc always closes; focus returns to where it was.

import { COMMANDS, GROUP_TITLES } from '../cmd/registry.js';
import { BOOT, EFFECTS, THEMES } from '../core/settings.js';
import { esc } from '../lib/format.js';
import { $, $$, h, trapFocus } from '../lib/dom.js';

let open = null; // the dialog currently shown

export const isOpen = () => !!open;

// Shows a dialog; resolves with the value of the button pressed, or null when dismissed.
export function dialog({ title, body, buttons = [], cls = '', width, onKey, onMount, labelledBy, beforeClose }) {
  closeNow(null);
  const back = document.activeElement;
  const layer = document.getElementById('layer');
  const scrim = h('div', { class: 'scrim' });
  const box = h('div', { class: `dlg ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy || 'dlg-title' });
  if (width) box.style.setProperty('--w', width);
  box.innerHTML = `
    <h2 class="ptitle"><span class="name" id="dlg-title">${esc(title)}</span><span class="spacer"></span><span class="meta">esc closes</span></h2>
    <div class="dlg-body">${body}</div>
    ${buttons.length ? `<div class="dlg-foot">${buttons.map((b, i) => `
      <button type="button" class="btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}" data-i="${i}">${b.key ? `<kbd>${esc(b.key)}</kbd> ` : ''}${esc(b.label)}</button>`).join('')}</div>` : ''}`;
  layer.append(scrim, box);
  const untrap = trapFocus(box);

  return new Promise((resolve) => {
    const finish = (value) => {
      if (beforeClose) value = beforeClose(value, box); // read inputs while they still exist
      untrap();
      scrim.remove();
      box.remove();
      document.removeEventListener('keydown', keys, true);
      open = null;
      if (back && back.isConnected) back.focus({ preventScroll: true });
      resolve(value);
    };
    const keys = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        return finish(null);
      }
      if (onKey && onKey(e, finish, box)) {
        e.stopPropagation();
        return;
      }
      const inField = e.target.matches('input, textarea, select');
      if (!inField && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const b = buttons.find((x) => x.key && x.key.toLowerCase() === e.key.toLowerCase());
        if (b) {
          e.preventDefault();
          e.stopPropagation();
          finish(b.value);
        }
      }
    };
    document.addEventListener('keydown', keys, true);
    scrim.addEventListener('click', () => finish(null));
    box.addEventListener('click', (e) => {
      const b = e.target.closest('.dlg-foot .btn');
      if (b) finish(buttons[Number(b.dataset.i)].value);
    });
    open = { finish };
    onMount?.(box, finish);
    if (!box.contains(document.activeElement)) { // unless onMount already chose where focus goes
      const first = $('[autofocus]', box) || $$('.dlg-foot .btn', box).find((b, i) => buttons[i].focus) || $('.dlg-foot .btn', box) || box;
      if (first === box) box.tabIndex = -1;
      first.focus({ preventScroll: true });
    }
  });
}

export function closeNow(value = null) {
  if (open) open.finish(value);
}

// [y/N] confirmation. Enter activates the focused button: "no" for dangerous actions.
export async function confirm({ title, body, yes = 'yes', no = 'cancel', danger = false }) {
  const v = await dialog({
    title, cls: danger ? 'danger' : '', width: '64ch',
    body: `${body}<p class="yn">${danger ? 'This cannot be undone from the cluster itself.' : ''} Press <kbd>y</kbd> to confirm or <kbd>n</kbd> / <kbd>esc</kbd> to cancel.</p>`,
    buttons: [
      { label: no, key: 'n', value: false, focus: danger },
      { label: yes, key: 'y', value: true, primary: !danger, danger, focus: !danger },
    ],
  });
  return v === true;
}

// Radio list. options: [{value, label, sub}]; extra HTML (inputs) can follow an option via `after`.
// With `collect(box)`, resolves to {value, data} so inline inputs can be read.
export function choose({ title, body = '', options, initial = 0, confirmLabel = 'ok', danger = false, onMount, collect, width = '70ch' }) {
  let idx = Math.max(0, initial);
  const html = `${body}<div role="radiogroup" aria-label="${esc(title)}">${options.map((o, i) => `
    <div class="choice" role="radio" tabindex="${i === idx ? 0 : -1}" aria-checked="${i === idx}" data-i="${i}">
      <span class="mk">${i === idx ? '◆' : '◇'}</span><span>${o.label}</span>${o.sub ? `<span class="sub">${o.sub}</span>` : ''}
    </div>${o.after || ''}`).join('')}</div>`;
  const paint = (box) => $$('.choice', box).forEach((c, i) => {
    c.setAttribute('aria-checked', String(i === idx));
    c.tabIndex = i === idx ? 0 : -1;
    $('.mk', c).textContent = i === idx ? '◆' : '◇';
  });
  return dialog({
    title, width, cls: danger ? 'danger' : '', body: html,
    buttons: [{ label: 'cancel', value: null }, { label: confirmLabel, key: '⏎', value: '__ok', primary: !danger, danger, focus: false }],
    beforeClose: (v, box) => (v === '__ok' ? { ok: true, data: collect ? collect(box) : null } : null),
    onMount(box, finish) {
      box.addEventListener('click', (e) => {
        const c = e.target.closest('.choice');
        if (!c) return;
        idx = Number(c.dataset.i);
        paint(box);
        if (e.detail === 2) finish('__ok');
      });
      $$('.choice', box)[idx].focus();
      onMount?.(box, () => idx, (i) => { idx = i; paint(box); });
    },
    onKey(e, finish, box) {
      const inField = e.target.matches('input');
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !inField) {
        e.preventDefault();
        idx = (idx + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
        paint(box);
        $$('.choice', box)[idx].focus();
        return true;
      }
      if (e.key === 'Enter' && !e.target.closest('.dlg-foot')) {
        e.preventDefault();
        finish('__ok');
        return true;
      }
      if (/^[1-9]$/.test(e.key) && !inField && Number(e.key) <= options.length) {
        idx = Number(e.key) - 1;
        paint(box);
        $$('.choice', box)[idx].focus();
        return true;
      }
      return false;
    },
  }).then((v) => {
    if (!v?.ok) return null;
    return collect ? { value: options[idx].value, data: v.data } : options[idx].value;
  });
}

// ---- help -------------------------------------------------------------------------------------

const KEYS_NAV = [
  ['?', 'this help'], [': or ⌘K/Ctrl+K', 'type a command (palette)'], ['/', 'filter the current list'],
  ['1 – 5', 'home · jobs · machines · log · sim'], ['⇥ / ⇧⇥', 'next / previous panel'],
  ['↑ ↓  j k', 'move the selection'], ['g / G', 'first / last'], ['⏎', 'open the selected job or machine'],
  ['n', 'new job'], ['e', 'edit the selected job'], ['r', 'reschedule the selected job'],
  ['d', 'delete / kill the selected job'], ['f', 'fail the selected machine'], ['p', 'scoring policy'],
  ['u', 'undo the last change'], ['z', 'maximise the focused panel'], ['space', 'pause / resume live updates'],
  ['`', 'show / hide the console'], ['esc', 'go back one level'],
];
const KEYS_CMD = [
  ['⏎', 'run the command'], ['⇥ or →', 'accept the suggestion'], ['↑ ↓', 'choose a suggestion (recent first)'],
  ['esc', 'clear, then back to keys mode'], ['Ctrl+U', 'clear the line'], ['Ctrl+L', 'clear the console'],
];
const GLOSSARY = [
  ['job', 'a program you ask the cell to run, as one or more identical tasks'],
  ['task', 'one copy of a job, running on one machine'],
  ['priority', 'free < batch (100) < production (200) < monitoring (300); higher wins'],
  ['preemption', 'a higher-priority task evicts lower-priority ones when the cell is full'],
  ['service / batch', 'services restart when they crash; batch jobs run to completion'],
  ['policy', 'how the scheduler picks a machine: hybrid, best fit or worst fit'],
  ['machine', 'a Borglet container with its own CPU and RAM'],
  ['cgroup', 'the Linux feature that caps each task to its CPU and memory'],
];

export function openHelp(shell) {
  const cmdRows = Object.entries(GROUP_TITLES).map(([g, title]) => {
    const rows = COMMANDS.filter((c) => c.group === g && !c.hidden).map((c) => `
      <div class="help-row cmd" tabindex="0" data-cmd="${esc(c.name)}" title="${esc(c.usage)}" data-text="${esc(`${c.name} ${(c.aliases || []).join(' ')} ${c.summary}`)}">
        <span class="hk">${esc(c.usage)}</span><span class="hd">${esc(c.summary)}</span></div>`).join('');
    return `<section class="help-sect"><h3>${esc(title)}</h3>${rows}</section>`;
  }).join('');
  const keyRows = (list) => list.map(([k, d]) => `<div class="help-row" data-text="${esc(`${k} ${d}`)}"><span class="hk"><kbd>${esc(k)}</kbd></span><span class="hd">${esc(d)}</span></div>`).join('');
  const body = `
    <input class="help-filter" type="text" placeholder="filter: e.g. delete, priority, ssd" aria-label="filter help" autofocus>
    <div class="help-grid">
      <section class="help-sect" data-always="1"><h3>getting started</h3>
        <ol class="steps">
          <li>Press <kbd>n</kbd> (or click <b>+ new job</b>), pick a preset, press <kbd>⏎</kbd>.</li>
          <li>Watch it on <b>home</b> (<kbd>1</kbd>): queued ◌ → running ▶ → done ✓.</li>
          <li>Select it and press <kbd>e</kbd> edit, <kbd>r</kbd> reschedule or <kbd>d</kbd> delete. <kbd>u</kbd> undoes.</li>
        </ol>
        <p class="dim" style="margin-top:.4em">Everything is also clickable. Type <b>tour</b> for a guided scenario.</p>
      </section>
      <section class="help-sect"><h3>keys (panels focused · NAV)</h3>${keyRows(KEYS_NAV)}</section>
      <section class="help-sect"><h3>keys (typing · CMD)</h3>${keyRows(KEYS_CMD)}</section>
      ${cmdRows}
      <section class="help-sect"><h3>glossary</h3>${GLOSSARY.map(([k, d]) => `<div class="help-row" data-text="${esc(`${k} ${d}`)}"><span class="hk term">${esc(k)}</span><span class="hd">${esc(d)}</span></div>`).join('')}</section>
    </div>`;
  return dialog({
    title: 'help · every key and command (click a command to use it)', width: '132ch', body,
    onMount(box, finish) {
      const filter = $('.help-filter', box);
      filter.addEventListener('input', () => {
        const q = filter.value.trim().toLowerCase();
        for (const r of $$('.help-row', box)) r.hidden = q && !r.dataset.text.toLowerCase().includes(q);
        for (const s of $$('.help-sect', box)) s.hidden = q && !s.dataset.always && !$$('.help-row', s).some((r) => !r.hidden);
      });
      const use = (row) => {
        finish(null);
        const c = COMMANDS.find((x) => x.name === row.dataset.cmd);
        if (c) shell.prompt.open(c.args || c.kv ? `${c.name} ` : c.name);
      };
      box.addEventListener('click', (e) => {
        const row = e.target.closest('[data-cmd]');
        if (row) use(row);
      });
      box.addEventListener('keydown', (e) => {
        const row = e.target.closest?.('[data-cmd]');
        if (row && e.key === 'Enter') {
          e.preventDefault();
          use(row);
        }
      });
    },
  });
}

// ---- settings -----------------------------------------------------------------------------------

export function openSettings(shell, settings) {
  const s = () => settings.get();
  const NAMES = { crt: 'crt frame', letterKeys: 'letter keys', safeMode: 'safe mode' };
  const radio = (name, entries, cur) => entries.map(([v, label]) => `
    <div class="srow"><button type="button" class="opt" role="radio" data-set="${name}" data-v="${esc(v)}" aria-checked="${cur === v}">${esc(v)}</button><span class="dim">${esc(label)}</span></div>`).join('');
  const toggle = (k, label) => `
    <div class="srow"><button type="button" class="opt" role="switch" data-toggle="${k}" aria-checked="${!!s()[k]}">${esc(NAMES[k] || k)}</button><span class="dim">${esc(label)}</span></div>`;
  const body = () => `
    <div class="help-grid">
      <section class="help-sect"><h3>theme</h3><div role="radiogroup" aria-label="theme">${radio('theme', Object.entries(THEMES), s().theme)}</div></section>
      <section class="help-sect"><h3>effects</h3>${Object.entries(EFFECTS).map(([k, v]) => toggle(k, v)).join('')}</section>
      <section class="help-sect"><h3>boot screen</h3><div role="radiogroup" aria-label="boot screen">${radio('boot', Object.entries(BOOT), s().boot)}</div></section>
      <section class="help-sect"><h3>keys &amp; safety</h3>
        ${toggle('letterKeys', 'single-key shortcuts (n, e, r, d …); when off, use Ctrl/⌘K, arrows, Tab, Enter, Esc')}
        ${toggle('safeMode', 'read-only: block every change to the cluster (good for demos)')}
      </section>
    </div>
    <p class="dim" style="margin-top:.8em">Saved in this browser. Commands: <b>theme</b>, <b>fx</b>, <b>settings</b>.</p>`;
  return dialog({
    title: 'settings', width: '110ch', body: body(),
    buttons: [{ label: 'reset to defaults', value: 'reset' }, { label: 'done', key: '⏎', value: null, primary: true, focus: true }],
    onMount(box) {
      box.addEventListener('click', (e) => {
        const o = e.target.closest('[data-set], [data-toggle]');
        if (!o) return;
        if (o.dataset.set) settings.set({ [o.dataset.set]: o.dataset.v });
        else settings.set({ [o.dataset.toggle]: !s()[o.dataset.toggle] });
        $('.dlg-body', box).innerHTML = body();
        $(`[data-set="${o.dataset.set}"][data-v="${o.dataset.v}"], [data-toggle="${o.dataset.toggle}"]`, box)?.focus();
      });
    },
    onKey(e, finish) {
      if (e.key === 'Enter' && !e.target.closest('.opt, .btn')) {
        finish(null);
        return true;
      }
      return false;
    },
  }).then((v) => {
    if (v === 'reset') {
      settings.reset();
      shell.ok('settings reset to defaults');
    }
  });
}
