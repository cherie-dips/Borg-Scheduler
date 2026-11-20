// The command line: a real <input> (for IME, screen readers and selection) under a mirror
// layer that draws the block cursor and fish-style ghost text. It doubles as the command
// palette: suggestions pop up above it, recent commands first.

import { accept, complete } from '../cmd/complete.js';
import { COMMANDS } from '../cmd/registry.js';
import { esc } from '../lib/format.js';
import { $, h } from '../lib/dom.js';

const HIST_KEY = 'mini-borg.history.v1';
const KEY_OF = { schedule: 'n', edit: 'e', reschedule: 'r', rm: 'd', fail: 'f', policy: 'p', help: '?', home: '1', jobs: '2', machines: '3', log: '4', sim: '5' };

export class Prompt {
  constructor(shell, dock) {
    this.shell = shell;
    this.mode = 'nav'; // nav (blurred) | cmd | filter
    this.items = [];
    this.res = null;
    this.hi = -1;      // highlighted suggestion; -1 = none chosen with the arrows yet
    this.history = loadHistory();

    this.palette = h('div', { class: 'palette', id: 'palette', role: 'listbox', 'aria-label': 'suggestions', hidden: true });
    this.root = h('div', { class: 'prompt', id: 'prompt' });
    this.root.innerHTML = `
      <span class="ps1" id="ps1"></span>
      <div class="cmdline">
        <input id="cmd" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
          role="combobox" aria-autocomplete="list" aria-controls="palette" aria-expanded="false"
          aria-label="command line: press colon to type a command">
        <div class="layer" aria-hidden="true"><span class="pad"></span><span class="cursor hollow"> </span><span class="ghost"></span></div>
      </div>`;
    dock.append(this.palette);
    this.input = $('input', this.root);
    this.layer = $('.layer', this.root);

    this.input.addEventListener('focus', () => this.shell.setMode(this.mode === 'filter' ? 'filter' : 'cmd'));
    this.input.addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement !== this.input && this.mode !== 'nav' && !this.palette.matches(':hover')) this.close(false);
    }, 0));
    this.input.addEventListener('input', () => this.update(true));
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('keyup', () => this.drawCursor());
    this.input.addEventListener('click', () => this.drawCursor());
    this.input.addEventListener('scroll', () => this.drawCursor());
    this.root.addEventListener('click', (e) => {
      const crumb = e.target.closest('[data-crumb]');
      if (crumb) return this.shell.act(crumb.dataset.crumb);
      if (e.target !== this.input) this.open();
    });
    this.palette.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the input
    this.palette.addEventListener('click', (e) => {
      const it = e.target.closest('.pi');
      if (it) this.choose(Number(it.dataset.i), true);
    });
  }

  // Opens the command line (CMD mode), optionally with some text in it.
  open(text = null) {
    this.mode = 'cmd';
    if (text != null) this.input.value = text;
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    this.update(false);
  }

  // Opens the live filter for the current view (FILTER mode).
  openFilter(current = '') {
    this.mode = 'filter';
    this.input.value = current;
    this.input.focus();
    this.shell.setMode('filter');
    this.update(false);
  }

  close(blur = true) {
    const wasFilter = this.mode === 'filter';
    this.mode = 'nav';
    this.hidePalette();
    if (!wasFilter) this.input.value = '';
    if (blur) this.input.blur();
    this.shell.setMode('nav');
    this.drawCursor();
  }

  update(typed) {
    if (this.mode === 'filter') {
      this.shell.setFilter(this.input.value);
      this.hidePalette();
      return this.drawCursor();
    }
    if (typed) this.hi = -1;
    this.res = complete(this.input.value, this.shell.ctx());
    this.items = this.res.items;
    if (!this.input.value.trim()) this.items = [...this.recent(), ...this.items.map((i) => ({ ...i, key: KEY_OF[i.value] }))];
    this.showPalette();
    this.drawCursor();
  }

  recent() {
    return this.history.slice(-5).reverse().map((cmd) => ({ value: cmd, insert: cmd, hint: 'recent', kind: 'recent', recent: true }));
  }

  showPalette() {
    if (this.mode !== 'cmd' || !this.items.length) return this.hidePalette();
    const title = this.input.value.trim() ? this.res.title : 'recent commands, then every command · ↑↓ choose · Tab complete';
    const rows = this.items.map((it, i) => `
      <div class="pi${it.recent ? ' recent' : ''}" role="option" id="pi-${i}" data-i="${i}" aria-selected="${i === this.hi}">
        <span class="pv">${esc(it.value)}</span><span class="ph">${esc(it.hint || '')}</span><span class="pk">${it.key ? `<kbd>${esc(it.key)}</kbd>` : esc(it.kind && it.kind !== 'command' && it.kind !== 'recent' ? it.kind : '')}</span>
      </div>`).join('');
    this.palette.innerHTML = `<div class="ptitle-row"><span>${esc(title || '')}</span><span>${this.items.length} match${this.items.length === 1 ? '' : 'es'}</span></div>${rows}`;
    this.palette.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-activedescendant', this.hi >= 0 ? `pi-${this.hi}` : '');
    if (this.hi >= 0) $(`#pi-${this.hi}`, this.palette)?.scrollIntoView({ block: 'nearest' });
  }

  hidePalette() {
    this.palette.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  // Accepts suggestion i; runs it straight away when nothing more is needed.
  choose(i, fromClick = false) {
    const it = this.items[i];
    if (!it) return;
    if (it.recent) return this.submit(it.value);
    this.input.value = this.res && !it.recent ? accept(this.input.value.trim() ? this.input.value : '', this.res, it) : it.insert;
    this.hi = -1;
    const cmd = COMMANDS.find((c) => c.name === it.value);
    if (fromClick && cmd && !cmd.args && !cmd.kv) return this.submit(this.input.value);
    this.input.focus();
    this.update(false);
  }

  onKey(e) {
    if (this.mode === 'filter') {
      if (e.key === 'Enter') {
        e.preventDefault();
        return this.close();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.input.value = '';
        this.shell.setFilter('');
        return this.close();
      }
      return;
    }
    const n = this.items.length;
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        if (this.hi >= 0) return this.choose(this.hi);
        return this.submit(this.input.value);
      case 'Tab':
        if (!n) return; // let Tab move focus when there is nothing to complete
        e.preventDefault();
        return this.choose(this.hi >= 0 ? this.hi : 0);
      case 'ArrowRight':
        if (this.res?.ghost && this.input.selectionStart === this.input.value.length) {
          e.preventDefault();
          this.input.value += this.res.ghost;
          this.update(false);
        }
        return;
      case 'ArrowDown':
      case 'ArrowUp':
        if (!n) return;
        e.preventDefault();
        this.hi = e.key === 'ArrowDown' ? (this.hi + 1) % n : (this.hi <= 0 ? n - 1 : this.hi - 1);
        return this.showPalette();
      case 'Escape':
        e.preventDefault();
        if (this.hi >= 0) {
          this.hi = -1;
          return this.showPalette();
        }
        if (this.input.value) {
          this.input.value = '';
          return this.update(true);
        }
        this.close();
        return this.shell.focusPanel();
      default:
        if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) {
          e.preventDefault();
          this.input.value = '';
          this.update(true);
        } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
          e.preventDefault();
          this.shell.console.clear();
        } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && !this.input.value.slice(this.input.selectionStart, this.input.selectionEnd)) {
          e.preventDefault();
          if (this.input.value) this.shell.console.echo(`${this.input.value}^C`);
          this.input.value = '';
          this.update(true);
        }
        this.restartBlink();
    }
  }

  submit(text) {
    const line = text.trim();
    this.input.value = '';
    this.hi = -1;
    this.hidePalette();
    if (!line) return this.update(false);
    this.remember(line);
    this.close();
    this.shell.exec(line);
  }

  remember(line) {
    this.history = this.history.filter((l) => l !== line);
    this.history.push(line);
    if (this.history.length > 50) this.history.shift();
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(this.history));
    } catch {
      /* storage blocked */
    }
  }

  // Block cursor at the caret, ghost completion after the text.
  drawCursor() {
    const v = this.input.value;
    const pos = this.input.selectionStart ?? v.length;
    const focused = document.activeElement === this.input;
    let ghost = focused && this.mode === 'cmd' && pos === v.length ? this.res?.ghost || '' : '';
    if (!v) {
      // An empty line shows what to do next, like a terminal hint.
      ghost = !focused ? ' press : to type a command · ? help'
        : this.mode === 'filter' ? ' type to filter · ! inverts · ⏎ keeps · esc clears'
          : ' type a command, e.g. help or schedule · ⇥ completes · esc goes back';
    }
    const pad = this.layer.querySelector('.pad');
    const cur = this.layer.querySelector('.cursor');
    pad.textContent = v.slice(0, pos);
    cur.textContent = v[pos] && v[pos] !== ' ' ? v[pos] : ' ';
    cur.className = `cursor${focused ? '' : ' hollow'}`;
    this.layer.querySelector('.ghost').textContent = cur.textContent === ' ' ? ghost : '';
    this.layer.scrollLeft = this.input.scrollLeft;
  }

  restartBlink() {
    const cur = this.layer.querySelector('.cursor');
    cur.classList.add('typing');
    clearTimeout(this.blinkTimer);
    this.blinkTimer = setTimeout(() => cur.classList.remove('typing'), 600);
  }

  // The prompt's path is a breadcrumb: borg@local ~/jobs/web-frontend ❯
  setPath(parts) {
    const crumbs = parts.map((p, i) => `<button type="button" class="linkbtn crumb" data-crumb="${esc(p.act)}">${esc(p.label)}</button>${i < parts.length - 1 ? '/' : ''}`).join('');
    const html = `<span class="user">borg@</span><span class="host">local</span> ~/${crumbs} ❯`;
    const ps1 = $('#ps1', this.root);
    if (ps1.__html !== html) {
      ps1.__html = html;
      ps1.innerHTML = html;
    }
  }
}

function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    return Array.isArray(h) ? h.filter((x) => typeof x === 'string').slice(-50) : [];
  } catch {
    return [];
  }
}
