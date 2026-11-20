// The shell: the terminal frame (status line, view tabs, views, console, message line, command
// line, key bar), the NAV / CMD modes and keyboard map, focus and selection, and the actions
// that every command, key and click ends up calling.

import home from '../views/home.js';
import jobs from '../views/jobs.js';
import machines from '../views/machines.js';
import log from '../views/log.js';
import sim from '../views/sim.js';
import { Console } from './console.js';
import { JobForm } from './jobform.js';
import { Prompt } from './prompt.js';
import { runBoot } from './boot.js';
import * as overlay from './overlay.js';
import { announce, toast } from './toast.js';
import { keyBtn, sparkline } from './widgets.js';
import { POLICIES, lookup } from '../cmd/registry.js';
import { suggestCommand } from '../cmd/complete.js';
import { patchOf, specOf } from '../cmd/spec.js';
import { ApiError, api } from '../core/api.js';
import { derive } from '../core/model.js';
import { PRESETS, clone, presetByKey, uniqueName } from '../core/presets.js';
import { splitArgs, tokenize } from '../lib/parse.js';
import { clock, dur, esc, plural } from '../lib/format.js';
import { $, h, patch, resetCharWidth } from '../lib/dom.js';

const VIEWS = [home, jobs, machines, log, sim];
const FILTERABLE = { jobs: 'jobs', machines: 'machines', log: 'log' };

export class Shell {
  constructor(store, settings) {
    this.store = store;
    this.settings = settings;
    this.model = null;
    this.view = 'home';
    this.mode = 'nav';
    this.focus = Object.fromEntries(VIEWS.map((v) => [v.id, v.panels[0].id]));
    this.sel = { job: null, machine: null };
    this.filter = { jobs: '', machines: '', log: '' };
    this.logKinds = new Set();
    this.logFollow = true;
    this.zoomed = false;
    this.frame = 0;
    this.undoStack = [];
    this.hold = false;
    this.pending = false;
    this.build();
    this.bind();
    store.on((kind, data) => this.onStore(kind, data));
    settings.onChange(() => {
      resetCharWidth();
      this.render();
    });
    setInterval(() => this.tick(), 200);
  }

  // ---- frame -------------------------------------------------------------------------------

  build() {
    const app = document.getElementById('app');
    app.innerHTML = '';
    this.statusEl = h('header', { class: 'statusbar', 'aria-label': 'cell status' });
    this.tabsEl = h('nav', { class: 'tabs', 'aria-label': 'views and help' });
    this.tabsEl.innerHTML = `<div class="tablist" role="tablist" aria-label="views">${VIEWS.map((v, i) => `<button type="button" class="tab" role="tab" id="tab-${v.id}" aria-controls="v-${v.id}" data-act="view:${v.id}"><span class="n">${i + 1}</span> ${v.title}</button>`).join('')}</div>`
      + `<span class="grow"></span>${keyBtn('?', 'help', 'help')}${keyBtn(':', 'command', 'palette')}<button type="button" class="kbtn" data-act="settings">≡ settings</button>`;
    this.viewsEl = h('main', { class: 'views', id: 'views' });
    this.panels = {};
    for (const v of VIEWS) {
      const sec = h('section', { class: `view view-${v.id}`, id: `v-${v.id}`, role: 'tabpanel', 'aria-labelledby': `tab-${v.id}`, hidden: true });
      this.panels[v.id] = {};
      for (const def of v.panels) {
        const P = this.makePanel(def);
        this.panels[v.id][def.id] = P;
        sec.append(P.root);
      }
      this.viewsEl.append(sec);
    }
    app.append(this.statusEl, this.tabsEl, this.viewsEl);
    this.console = new Console(app);
    const dock = h('div', { class: 'dock' });
    this.msgEl = h('div', { class: 'msgline', id: 'msgline', role: 'status' });
    this.keysEl = h('footer', { class: 'keybar', id: 'keybar', 'aria-label': 'keys' });
    this.prompt = new Prompt(this, dock);
    dock.append(this.msgEl, this.prompt.root, this.keysEl);
    app.append(dock);
    this.form = new JobForm(this, dock);
    this.dock = dock;
  }

  makePanel(def) {
    const root = h('section', { class: `panel p-${def.id}`, 'data-panel': def.id, 'aria-label': def.title });
    root.innerHTML = `<h2 class="ptitle"><span class="name">${esc(def.title)}</span><span class="meta" hidden></span><span class="spacer"></span></h2><div class="pbody" tabindex="0"></div>`;
    const nameEl = $('.name', root), metaEl = $('.meta', root);
    return {
      id: def.id, root, body: $('.pbody', root),
      title(t) { if (nameEl.textContent !== t) nameEl.textContent = t; },
      meta(t) { if (metaEl.textContent !== t) metaEl.textContent = t; metaEl.hidden = !t; },
    };
  }

  show() {
    document.getElementById('app').hidden = false;
    this.setView('home');
    this.prompt.drawCursor();
    if (!this.store.model?.jobs?.length) this.info('welcome · press n to schedule a job, ? for help, : to type a command');
    else this.info('press ? for help · : to type a command · n new job');
  }

  bind() {
    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('pointerdown', () => { this.hold = true; }, true);
    const release = () => {
      this.hold = false;
      if (this.pending) setTimeout(() => this.render(), 0); // after the click has been dispatched
    };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    window.addEventListener('resize', () => this.render());

    const app = document.getElementById('app');
    app.addEventListener('click', (e) => this.onClick(e));
    app.addEventListener('dblclick', (e) => {
      const job = e.target.closest('[data-job]');
      if (job) return this.setView('jobs', { select: Number(job.dataset.job) });
      const m = e.target.closest('[data-machine]');
      if (m) this.setView('machines', { select: Number(m.dataset.machine) });
    });
    const logBody = this.panels.log.events.body;
    logBody.addEventListener('scroll', () => {
      const atEnd = logBody.scrollTop + logBody.clientHeight >= logBody.scrollHeight - 4;
      if (atEnd !== this.logFollow) {
        this.logFollow = atEnd;
        this.render();
      }
    });
  }

  onClick(e) {
    const t = e.target;
    const act = t.closest('[data-act]');
    if (act) {
      e.preventDefault();
      return this.act(act.dataset.act, act.dataset);
    }
    const job = t.closest('[data-job]');
    const machine = t.closest('[data-machine]');
    const panel = t.closest('.panel[data-panel]');
    if (panel && panel.closest('.view')) this.focusPanel(panel.dataset.panel, false);
    if (job) {
      this.sel.job = Number(job.dataset.job);
      if (!panel || panel.closest('#v-machines')) return this.setView('jobs', { select: this.sel.job });
    }
    if (machine) {
      this.sel.machine = Number(machine.dataset.machine);
      if (machine.classList.contains('linkbtn') || panel?.closest('#v-home') && !machine.classList.contains('lrow')) {
        return this.setView('machines', { select: this.sel.machine });
      }
    }
    this.render();
  }

  // ---- modes, focus, views -------------------------------------------------------------------

  setMode(m) {
    this.mode = m;
    document.documentElement.dataset.mode = m;
    this.renderKeys();
  }

  viewDef(id = this.view) {
    return VIEWS.find((v) => v.id === id);
  }

  setView(id, opts = {}) {
    if (!this.viewDef(id)) return;
    if (this.view !== id) this.zoomed = false;
    this.view = id;
    for (const v of VIEWS) {
      $(`#v-${v.id}`).hidden = v.id !== id;
      $(`#tab-${v.id}`).setAttribute('aria-selected', String(v.id === id));
    }
    if (opts.select != null) {
      if (id === 'machines') this.sel.machine = opts.select;
      else this.sel.job = opts.select;
    }
    if (opts.filter !== undefined && FILTERABLE[id]) this.filter[id] = opts.filter || '';
    const v = this.viewDef();
    this.focusPanel(opts.panel || (opts.select != null && v.panels.some((p) => p.id === 'detail') ? 'list' : this.focus[id]));
    if (id === 'sim') this.store.loadResults().then(() => this.render());
  }

  focusPanel(id = this.focus[this.view], takeFocus = true) {
    const v = this.viewDef();
    if (!v.panels.some((p) => p.id === id)) id = v.panels[0].id;
    this.focus[this.view] = id;
    if (this.prompt.mode !== 'nav') this.prompt.close(false);
    for (const [pid, P] of Object.entries(this.panels[this.view])) P.root.classList.toggle('focus', pid === id);
    if (takeFocus) this.panels[this.view][id].body.focus({ preventScroll: true });
    this.setMode('nav');
    this.render();
  }

  cyclePanel(dir) {
    const ids = this.viewDef().panels.map((p) => p.id);
    const i = ids.indexOf(this.focus[this.view]);
    this.focusPanel(ids[(i + dir + ids.length) % ids.length]);
  }

  // ---- keyboard ---------------------------------------------------------------------------------

  onKey(e) {
    if (overlay.isOpen() || this.form.isOpen) return;
    if (e.target.closest?.('input, textarea, select')) return; // the command line handles itself
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && (k === 'k' || k === 'K')) {
      e.preventDefault();
      return this.prompt.open();
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const char = k.length === 1 && k !== ' ';
    if (char && !this.settings.get().letterKeys) {
      return this.info('single-key shortcuts are off (settings) · Ctrl/⌘K opens the command line');
    }
    const keys = {
      '?': () => this.act('help'),
      ':': () => this.prompt.open(),
      '/': () => this.act('filter'),
      Tab: () => this.cyclePanel(e.shiftKey ? -1 : 1),
      ArrowDown: () => this.move(1), j: () => this.move(1),
      ArrowUp: () => this.move(-1), k: () => this.move(-1),
      PageDown: () => this.move(10), PageUp: () => this.move(-10),
      Home: () => this.move(-Infinity), g: () => this.move(-Infinity),
      End: () => this.move(Infinity), G: () => this.move(Infinity),
      Enter: () => this.act('open'),
      Escape: () => this.back(),
      n: () => this.act('new'), e: () => this.act('edit'), r: () => this.act('resched'), d: () => this.act('delete'),
      f: () => this.act('fail'), p: () => this.act('policy'), u: () => this.act('undo'), z: () => this.act('zoom'),
      ' ': () => this.act('pause'), '`': () => this.act('console'),
    };
    for (let i = 0; i < VIEWS.length; i++) keys[String(i + 1)] = () => this.setView(VIEWS[i].id);
    const fn = keys[k];
    if (fn) {
      e.preventDefault();
      return fn();
    }
    if (char) this.info(`keys mode: "${k}" does nothing here · press : to type a command, ? for help`);
  }

  move(delta) {
    const v = this.viewDef(), panelId = this.focus[this.view];
    const L = v.list(this, panelId);
    if (!L) {
      const body = this.panels[this.view][panelId].body;
      const line = parseFloat(getComputedStyle(body).lineHeight) || 20;
      if (delta === Infinity) {
        body.scrollTop = body.scrollHeight;
        if (this.view === 'log') this.logFollow = true;
      } else if (delta === -Infinity) body.scrollTop = 0;
      else body.scrollTop += delta * (Math.abs(delta) >= 10 ? body.clientHeight / 10 : line);
      return this.render();
    }
    if (!L.ids.length) return;
    let i = L.ids.indexOf(this.sel[L.kind]);
    if (delta === Infinity) i = L.ids.length - 1;
    else if (delta === -Infinity) i = 0;
    else i = i < 0 ? (delta > 0 ? 0 : L.ids.length - 1) : Math.max(0, Math.min(L.ids.length - 1, i + delta));
    this.sel[L.kind] = L.ids[i];
    this.render();
    $('.sel', this.panels[this.view][panelId].body)?.scrollIntoView({ block: 'nearest' });
  }

  // Esc in keys mode: back one level.
  back() {
    if (this.console.visible) return this.console.show(false);
    const f = FILTERABLE[this.view];
    if (f && this.filter[f]) return this.setFilter('');
    if (this.zoomed) return this.act('zoom');
    const v = this.viewDef();
    if (this.focus[this.view] !== v.panels[0].id) return this.focusPanel(v.panels[0].id);
    if (this.view !== 'home') return this.info('esc: nothing to go back to here · 1 home · ? help');
    this.info('you are home · ? help · : command');
  }

  setFilter(text) {
    const target = FILTERABLE[this.view];
    if (!target) return;
    this.filter[target] = text;
    this.render();
  }

  // ---- actions ------------------------------------------------------------------------------------

  async act(name, data = {}) {
    if (name.startsWith('view:')) return this.setView(name.slice(5));
    const job = this.selectedJob();
    switch (name) {
      case 'view': return this.setView(data.view, { filter: data.filter });
      case 'help': return overlay.openHelp(this);
      case 'settings': return overlay.openSettings(this, this.settings);
      case 'palette': return this.prompt.open();
      case 'filter': {
        if (!FILTERABLE[this.view]) this.setView('jobs');
        return this.prompt.openFilter(this.filter[FILTERABLE[this.view]]);
      }
      case 'clear-filter': return this.setFilter('');
      case 'open': {
        const v = this.viewDef(), panelId = this.focus[this.view], L = v.list(this, panelId);
        if (L && this.sel[L.kind] != null) return v.open(this, panelId, this.sel[L.kind]);
        return this.info('select something first: ↑↓ or click');
      }
      case 'new': return this.openForm({ mode: 'new', spec: clone(PRESETS[0].spec) });
      case 'preset': {
        const p = presetByKey(data.preset);
        return this.openForm({ mode: 'new', spec: { ...clone(p.spec), name: uniqueName(p.spec.name, this.jobNames()) } });
      }
      case 'edit':
        if (!job) return this.needJob('edit');
        return this.openForm({ mode: 'edit', job, spec: specOf(job) });
      case 'resched':
        if (!job) return this.needJob('reschedule');
        return this.openReschedule(job);
      case 'delete':
        if (!job) return this.needJob('delete');
        return this.deleteDialog(job);
      case 'fail': {
        const m = this.selectedMachine();
        if (this.view !== 'machines' || !m) return this.info('fail works on a machine: go to 3 machines, select one, press f');
        return this.failMachine(m, 20, { confirm: true });
      }
      case 'policy': return this.policyPicker();
      case 'undo': return this.undo();
      case 'zoom': {
        this.zoomed = !this.zoomed;
        $(`#v-${this.view}`).classList.toggle('zoomed', this.zoomed);
        this.info(this.zoomed ? 'panel maximised · z or esc restores' : 'panels restored');
        return this.render();
      }
      case 'pause': {
        this.store.setPaused(!this.store.paused);
        this.info(this.store.paused ? 'live updates paused · space resumes' : 'live updates resumed');
        return this.render();
      }
      case 'console': return this.console.toggle();
      case 'clear-console': return this.console.clear();
      case 'kind': {
        if (!data.kind) this.logKinds.clear();
        else if (this.logKinds.has(data.kind)) this.logKinds.delete(data.kind);
        else this.logKinds.add(data.kind);
        return this.render();
      }
      case 'follow': {
        this.logFollow = true;
        return this.render();
      }
      case 'tour': return this.runDemo({ confirm: true });
      default: return this.info(`unknown action ${name}`);
    }
  }

  needJob(verb) {
    if (!this.model?.jobs.length) return this.info(`no jobs to ${verb} yet · press n to schedule one`);
    this.prompt.open(`${verb === 'delete' ? 'rm' : verb} `);
    this.info(`${verb} which job? pick one from the list (↑↓ Tab ⏎) or select a job first`);
  }

  jobNames() {
    return (this.model?.jobs || []).map((j) => j.name);
  }

  // ---- the ctx.ui interface used by commands -----------------------------------------------------

  ctx() {
    this.refreshModel();
    return { model: this.model, api, ui: this, settings: this.settings };
  }

  selectedJob() {
    return this.sel.job != null ? this.model?.jobsById.get(this.sel.job) || null : null;
  }

  selectedMachine() {
    return this.sel.machine != null ? this.model?.machines.find((m) => m.id === this.sel.machine) || null : null;
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  async exec(line) {
    this.console.echo(line);
    const tokens = tokenize(line);
    if (!tokens.length) return;
    const word = tokens[0].text;
    if (word.startsWith('/')) return this.setFilter(line.trim().slice(1).trim());
    const cmd = lookup(word);
    if (!cmd) {
      const guess = suggestCommand(word);
      return this.fail(`unknown command "${word}"${guess ? `: did you mean ${guess}?` : ''} · type help for the list`);
    }
    try {
      await cmd.run(this.ctx(), { cmd, args: splitArgs(tokens.slice(1)), raw: line });
    } catch (e) {
      this.fail(e instanceof ApiError ? e.message : `${cmd.name}: ${e.message}`);
    }
  }

  // `undoable`: the action just taken can be undone, so offer the link right there.
  message(level, text, { console = true, undoable = false } = {}) {
    const glyph = { ok: '✓', err: '✗', info: '▸' }[level];
    const undo = undoable ? ` <button type="button" class="linkbtn" data-act="undo">undo (u)</button>` : '';
    this.msgEl.innerHTML = `<span class="${level}">${glyph}</span> ${esc(text)}${undo}`;
    if (console && level !== 'info') this.console.print([{ cls: level === 'err' ? 'err' : 'ok', text: `${glyph} ${text}` }], false);
    if (level !== 'info') announce(text);
  }
  ok(text, opts) { this.message('ok', text, opts); }
  fail(text) { this.message('err', text); }
  info(text) { this.message('info', text, { console: false }); }

  print(lines) {
    this.console.print(lines);
  }

  clearConsole() {
    this.console.clear();
  }

  openHelp() {
    return overlay.openHelp(this);
  }

  openSettings() {
    return overlay.openSettings(this, this.settings);
  }

  refresh() {
    return this.store.refresh();
  }

  replayBoot() {
    return runBoot(this.store, 'full', { replay: true });
  }

  // Safe mode makes the UI read-only.
  guard() {
    if (!this.settings.get().safeMode) return true;
    this.fail('safe mode is on: changes to the cluster are disabled (settings → safe mode)');
    return false;
  }

  openForm(opts) {
    if (!this.guard()) return;
    this.form.open(opts);
  }

  pushUndo(label, fn) {
    this.undoStack.push({ label, fn });
    if (this.undoStack.length > 20) this.undoStack.shift();
  }

  async undo() {
    const u = this.undoStack.at(-1);
    if (!u) return this.info('nothing to undo');
    if (!this.guard()) return;
    this.undoStack.pop();
    try {
      await u.fn();
      this.ok(`undone: ${u.label}`);
    } catch (e) {
      this.fail(`could not undo "${u.label}": ${e.message}`);
    }
    this.refresh();
  }

  async submitJob(spec, delay = 0) {
    if (!this.guard()) return false;
    try {
      const r = await api.submit({ ...spec, delay: delay || undefined });
      this.pushUndo(`schedule ${spec.name}`, () => api.remove(r.id));
      this.sel.job = r.id;
      this.ok(`scheduled ${spec.name} (${plural(spec.tasks, 'task')})${delay ? `, starts in ${dur(delay)}` : ''} · it shows up on home and in 2 jobs`, { undoable: true });
      await this.refresh();
      return true;
    } catch (e) {
      this.fail(`could not schedule ${spec.name}: ${e.message}`);
      return false;
    }
  }

  async applyEdit(job, spec) {
    if (!this.guard()) return false;
    const patchBody = patchOf(job, spec);
    if (!Object.keys(patchBody).length) {
      this.info(`nothing to change in ${job.name}`);
      return true;
    }
    const before = specOf(job);
    try {
      const r = await api.edit(job.id, patchBody);
      this.pushUndo(`edit ${job.name}`, () => api.edit(job.id, patchOf(spec, before)));
      this.ok(`updated ${job.name}: ${(r.changes || []).join(', ')} (${r.effect})`, { undoable: true });
      await this.refresh();
      return true;
    } catch (e) {
      this.fail(`could not edit ${job.name}: ${e.message}`);
      return false;
    }
  }

  async openReschedule(job) {
    if (!this.guard()) return;
    const effect = job.done
      ? `runs all ${plural(job.tasks, 'task')} of <b>${esc(job.name)}</b> again (run #${job.runs + 1})`
      : job.status === 'waiting' ? `moves the start of <b>${esc(job.name)}</b> (now ${clock(job.start_at)})`
        : `stops the ${plural(job.live, 'live task')} of <b>${esc(job.name)}</b> and queues them again, so the scheduler places them afresh`;
    const v = await overlay.choose({
      title: `reschedule ${job.name}`, confirmLabel: job.done ? 'run again' : job.status === 'waiting' ? 'move start' : 'restart',
      danger: !job.done && job.status !== 'waiting', // restarting live tasks: this dialog is the confirmation
      body: `<p>${effect}.</p><p class="mute" style="margin:.3em 0 .6em">Choose when (↑↓ or 1-3, then ⏎):</p>`,
      options: [
        { value: 'now', label: 'now' },
        { value: 'in', label: 'in', after: '<div style="margin:-.2em 0 .3em 3ch"><input type="number" name="secs" value="30" min="1" style="width:8ch"> <span class="mute">seconds</span></div>' },
        { value: 'at', label: 'at a time of day', after: `<div style="margin:-.2em 0 .3em 3ch"><input type="time" name="at" value="${nextQuarter()}"></div>` },
      ],
      onMount(box, getIdx, setIdx) {
        $('input[name="secs"]', box).addEventListener('focus', () => setIdx(1));
        $('input[name="at"]', box).addEventListener('focus', () => setIdx(2));
      },
      collect: (box) => ({ secs: Number($('input[name="secs"]', box).value), at: $('input[name="at"]', box).value }),
    });
    if (v == null) return;
    const { value: when, data: inputs } = v;
    let delay = 0;
    if (when === 'in') delay = inputs.secs;
    if (when === 'at') {
      const [hh, mm] = (inputs.at || '').split(':').map(Number);
      const t = new Date();
      t.setHours(hh, mm, 0, 0);
      if (t <= new Date()) t.setDate(t.getDate() + 1);
      delay = Math.round((t - new Date()) / 1000);
    }
    if (!(delay >= 0) || (when === 'in' && !(delay > 0))) return this.fail('reschedule: the delay must be a positive number of seconds');
    return this.reschedule(job, delay, { confirm: false });
  }

  async reschedule(job, delay, { confirm = true } = {}) {
    if (!this.guard()) return;
    if (confirm && !job.done && job.status !== 'waiting') {
      const yes = await overlay.confirm({
        title: `restart ${job.name}?`,
        body: `<p>Its ${plural(job.live, 'live task')} will be stopped and queued again${delay ? `, starting in ${dur(delay)}` : ''}.</p>`,
        yes: 'restart', danger: true,
      });
      if (!yes) return this.info('reschedule cancelled');
    }
    try {
      const r = await api.reschedule(job.id, delay);
      this.ok(`${r.message}${r.action === 'restarted' ? ' (cannot be undone)' : ''}`);
      await this.refresh();
    } catch (e) {
      this.fail(`could not reschedule ${job.name}: ${e.message}`);
    }
  }

  async deleteDialog(job) {
    if (!this.guard()) return;
    if (job.done) return this.removeJob(job, { confirm: true });
    const v = await overlay.choose({
      title: `delete ${job.name}?`, danger: true, confirmLabel: 'do it',
      body: `<p><b>${esc(job.name)}</b> has ${plural(job.live, 'live task')}. What should happen?</p><p class="mute" style="margin:.3em 0 .6em">↑↓ or 1-2 to choose, ⏎ to confirm, esc to cancel</p>`,
      options: [
        { value: 'kill', label: 'kill: stop it, keep it in the history', sub: 'undo runs it again' },
        { value: 'rm', label: 'delete: stop it and remove it completely', sub: 'undo resubmits the same spec' },
      ],
    });
    if (v === 'kill') return this.killJob(job, { confirm: false });
    if (v === 'rm') return this.removeJob(job, { confirm: false });
    this.info('delete cancelled');
  }

  async killJob(job, { confirm = true } = {}) {
    if (!this.guard()) return;
    if (job.done) return this.info(`${job.name} is not running (${job.status}); use rm to delete it`);
    if (confirm && !(await overlay.confirm({ title: `kill ${job.name}?`, danger: true, yes: 'kill',
      body: `<p>${plural(job.live, 'live task')} will be stopped. The job stays in the history.</p>` }))) return this.info('kill cancelled');
    try {
      await api.kill(job.id);
      this.pushUndo(`kill ${job.name}`, () => api.reschedule(job.id, 0));
      this.ok(`killed ${job.name}`, { undoable: true });
      await this.refresh();
    } catch (e) {
      this.fail(`could not kill ${job.name}: ${e.message}`);
    }
  }

  async removeJob(job, { confirm = true } = {}) {
    if (!this.guard()) return;
    if (confirm && !(await overlay.confirm({ title: `delete ${job.name}?`, danger: true, yes: 'delete',
      body: job.done ? `<p>Removes <b>${esc(job.name)}</b> (${job.status}) from the history.</p>`
        : `<p>Stops ${plural(job.live, 'live task')} and removes <b>${esc(job.name)}</b> completely.</p>` }))) return this.info('delete cancelled');
    const spec = specOf(job);
    try {
      await api.remove(job.id);
      this.pushUndo(`delete ${job.name}`, () => api.submit(spec));
      if (this.sel.job === job.id) this.sel.job = null;
      this.ok(`deleted ${job.name}`, { undoable: true });
      await this.refresh();
    } catch (e) {
      this.fail(`could not delete ${job.name}: ${e.message}`);
    }
  }

  async failMachine(m, secs = 20, { confirm = true } = {}) {
    if (!this.guard()) return;
    if (!m.up) return this.info(`${m.name} is already down`);
    if (confirm && !(await overlay.confirm({ title: `fail ${m.name}?`, danger: true, yes: 'fail it',
      body: `<p>${m.name} stops answering for ${secs} s and its ${plural(m.taskList.length, 'task')} are killed. After 3 missed polls the master marks it DOWN and reschedules that work elsewhere; the machine rejoins on its own.</p>` }))) return this.info('cancelled');
    try {
      await api.fail(m.id, secs);
      this.ok(`${m.name} fails for ${secs} s · watch it go DOWN in about 3 s`);
      await this.refresh();
    } catch (e) {
      this.fail(`could not fail ${m.name}: ${e.message}`);
    }
  }

  async setPolicy(name) {
    if (!this.guard()) return;
    const before = this.model?.raw.policy;
    await api.setPolicy(name);
    if (before && before !== name) this.pushUndo(`policy ${name}`, () => api.setPolicy(before));
    this.ok(`scoring policy is now ${name}: new placements use it`, { undoable: before && before !== name });
    await this.refresh();
  }

  async policyPicker() {
    const cur = this.model?.raw.policy;
    const keys = Object.keys(POLICIES);
    const v = await overlay.choose({
      title: 'scoring policy', confirmLabel: 'use it', initial: Math.max(0, keys.indexOf(cur)),
      body: '<p class="mute" style="margin-bottom:.5em">How the scheduler picks a machine for each task (§3.2 of the paper).</p>',
      options: keys.map((k) => ({ value: k, label: `${k}${k === cur ? '  (current)' : ''}`, sub: POLICIES[k] })),
    });
    if (v && v !== cur) {
      try {
        await this.setPolicy(v);
      } catch (e) {
        this.fail(e.message);
      }
    }
  }

  async runDemo({ confirm = true } = {}) {
    if (!this.guard()) return;
    const r = this.model?.raw;
    if (!r || !this.model.machines.length) return this.fail('the tour needs a running cell: docker compose up -d');
    if (confirm && !(await overlay.confirm({ title: 'run the guided tour?', yes: 'run tour',
      body: `<p>Schedules a small scenario:</p><ol class="steps"><li>a prod <b>web frontend</b> and a free-tier <b>crawler</b></li>
        <li>a <b>batch analytics</b> job sized to fill the cell</li><li>25 s later, a priority-250 <b>payments</b> job that has to preempt batch work</li></ol>
        <p class="mute">Watch home and the log. Delete the jobs afterwards with d (or rm).</p>` }))) return;
    const taken = this.jobNames();
    const mk = (key, over = {}) => {
      const s = { ...clone(presetByKey(key).spec), ...over };
      s.name = uniqueName(s.name, taken);
      taken.push(s.name);
      return s;
    };
    const web = mk('web'), crawler = mk('crawler');
    const free = r.capacity.cpu - r.allocated.cpu - web.cpu * web.tasks - crawler.cpu * crawler.tasks;
    const analytics = mk('analytics', { tasks: Math.max(4, Math.min(60, Math.floor(free / 0.3))) });
    const payments = mk('payments');
    try {
      for (const [s, delay] of [[web, 0], [crawler, 0], [analytics, 0], [payments, 25]]) await api.submit({ ...s, delay: delay || undefined });
      this.ok(`tour started: ${web.name}, ${crawler.name}, ${analytics.name} now; ${payments.name} in 25 s will preempt batch work`);
      this.setView('home');
      await this.refresh();
    } catch (e) {
      this.fail(`tour: ${e.message}`);
    }
  }

  // ---- data + rendering ---------------------------------------------------------------------------

  onStore(kind, data) {
    if (kind === 'disconnected') toast('err', `lost contact with the borgmaster (${data}); retrying every second`);
    if (kind === 'reconnected') toast('ok', 'reconnected to the borgmaster');
    if (kind === 'update') {
      // The first answer carries the whole history: only events after it are news worth a toast.
      const fresh = this.primed ? data.events || [] : [];
      this.primed = true;
      for (const n of data.notes || []) {
        const name = n.text.split(' ')[0];
        toast(n.level, n.text, () => this.setView('log', { filter: name }));
      }
      for (const e of fresh) {
        if (e.kind === 'oom' || e.kind === 'error') toast('err', e.msg, () => this.setView('log', { filter: e.msg.split(' ')[0].split('/')[0] }));
      }
      const m = this.store.model;
      if (m && this.sel.job != null && !m.jobsById.has(this.sel.job)) this.sel.job = null;
      if (this.view === 'jobs' && this.sel.job == null && m?.jobs.length) this.sel.job = m.jobs[0].id;
      if (this.view === 'machines' && this.sel.machine == null && m?.machines.length) this.sel.machine = m.machines[0].id;
      this.form.tick();
    }
    this.render();
  }

  refreshModel() {
    const raw = this.store.model?.raw;
    this.model = raw ? derive(raw, this.store.now()) : null;
  }

  tick() {
    this.frame++;
    if (this.store.paused || document.hidden) return;
    if (this.viewDef().ticks || this.frame % 5 === 0) this.render();
  }

  render() {
    if (this.hold) {
      this.pending = true;
      return;
    }
    this.pending = false;
    if (document.getElementById('app').hidden) return;
    this.refreshModel();
    if (this.view === 'jobs' && this.sel.job == null && this.model?.jobs.length) this.sel.job = this.model.jobs[0].id;
    if (this.view === 'machines' && this.sel.machine == null && this.model?.machines.length) this.sel.machine = this.model.machines[0].id;
    this.renderStatus();
    this.viewDef().render(this, this.panels[this.view]);
    this.renderKeys();
    this.renderPath();
  }

  renderStatus() {
    const m = this.model, s = this.store;
    const seg = (cls, html, act, title) => act
      ? `<button type="button" class="seg ${cls}" data-act="${act}" title="${esc(title || '')}">${html}</button>`
      : `<span class="seg ${cls}">${html}</span>`;
    const parts = [seg('brand', '◈ mini-borg'), seg('opt-mid', 'cell local')];
    if (s.connected === false) parts.push(seg('conn-bad', '✗ NO CONNECTION · retrying'));
    else parts.push(s.paused ? seg('live off', '○ PAUSED', 'pause', 'resume live updates (space)') : seg('live on', '● LIVE', 'pause', 'pause live updates (space)'));
    if (m) {
      const c = m.counts, r = m.raw;
      parts.push(seg('', `■ ${c.machinesUp}/${c.machines} up`, 'view:machines', 'machines (3)'));
      parts.push(seg('', `<span class="live">▶ ${c.running}</span> <span class="warn">◌ ${c.queued}</span> <span class="done">✓ ${c.done}</span>`, 'view:home', 'tasks: running, queued, done'));
      if (c.failed) parts.push(`<button type="button" class="seg err" data-act="view" data-view="jobs" data-filter="failed" title="show failed jobs">✗ ${c.failed} failed</button>`);
      const cpu = r.capacity.cpu ? Math.round((100 * r.allocated.cpu) / r.capacity.cpu) : 0;
      const ram = r.capacity.ram ? Math.round((100 * r.allocated.ram) / r.capacity.ram) : 0;
      parts.push(seg('opt-wide', `cpu ${cpu}% ${sparkline(s.history.cpuAlloc, 10)}`));
      parts.push(seg('opt-wide', `ram ${ram}%`));
      parts.push(seg('opt-mid', `policy <span class="hl">${esc(r.policy)}</span>`, 'policy', 'change the scoring policy (p)'));
    }
    if (this.settings.get().safeMode) parts.push(seg('warn strong', 'SAFE MODE', 'settings', 'read-only: open settings to change'));
    const html = `${parts.join('')}<span class="grow"></span>${seg('dim clock', clock(s.now()))}`;
    patch(this.statusEl, html);
  }

  renderKeys() {
    let items;
    const mode = this.mode;
    if (mode === 'cmd') items = [['⏎', 'run', null], ['⇥', 'complete', null], ['↑↓', 'choose', null], ['esc', 'back', null]];
    else if (mode === 'filter') items = [['⏎', 'keep filter', null], ['esc', 'clear filter', null], ['!', 'inverts', null]];
    else if (mode === 'form') items = [['⇥', 'next field', null], ['←→', 'choose', null], ['⏎', 'submit', null], ['esc', 'cancel', null]];
    else {
      items = [['?', 'help', 'help'], [':', 'command', 'palette'], ...this.viewDef().hints(this)];
      if (this.canUndo()) items.push(['u', 'undo', 'undo']);
      items.push(['z', this.zoomed ? 'restore' : 'zoom', 'zoom'], ['space', this.store.paused ? 'resume' : 'pause', 'pause'], ['p', 'policy', 'policy']);
    }
    const label = { nav: 'NAV', cmd: 'CMD', filter: 'FILTER', form: 'FORM' }[mode];
    const keys = items.map(([k, l, a]) => (a ? keyBtn(k, l, a) : `<span class="kbtn"><kbd>${esc(k)}</kbd> ${esc(l)}</span>`)).join('');
    const tail = mode === 'nav' ? `<span class="grow"></span><span class="dim">1-5 views · ⇥ panels</span>` : '<span class="grow"></span>';
    patch(this.keysEl, `<span class="mode ${mode === 'nav' ? 'nav' : 'cmd'}" title="${mode === 'nav' ? 'keys mode: single keys act; press : to type' : 'typing mode: keys type text; esc goes back'}">${label}</span>${keys}${tail}`);
  }

  renderPath() {
    const parts = [{ label: this.view, act: `view:${this.view}` }];
    if (this.view === 'jobs' && this.selectedJob()) parts.push({ label: this.selectedJob().name, act: `view:jobs` });
    if (this.view === 'machines' && this.selectedMachine()) parts.push({ label: this.selectedMachine().name, act: `view:machines` });
    if (FILTERABLE[this.view] && this.filter[FILTERABLE[this.view]]) parts.push({ label: `?filter=${this.filter[FILTERABLE[this.view]]}`, act: 'clear-filter' });
    this.prompt.setPath(parts);
  }
}

function nextQuarter() {
  const d = new Date(Date.now() + 15 * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(Math.floor(d.getMinutes() / 15) * 15).padStart(2, '0')}`;
}

