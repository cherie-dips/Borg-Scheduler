// The job form: a drawer that opens just above the command line, like a CLI wizard.
// Start from a preset or a blank job, adjust, press Enter. It validates as you type, tells
// you whether the job fits, and shows the equivalent command so the form teaches the CLI.

import { WORKLOADS, editEffect, patchOf, specOf, toArgs } from '../cmd/spec.js';
import { BLANK, PRESETS, clone, uniqueName } from '../core/presets.js';
import { NAME_RE, bandOf, parseWhen } from '../lib/parse.js';
import { esc, num } from '../lib/format.js';
import { $, $$, h } from '../lib/dom.js';

const BAND_OPTS = [['free', 0], ['batch', 100], ['prod', 200], ['monitoring', 300]];

export class JobForm {
  constructor(shell, dock) {
    this.shell = shell;
    this.dock = dock;
    this.el = null;
  }

  get isOpen() {
    return !!this.el;
  }

  open({ mode = 'new', spec, delay = 0, job = null }) {
    this.close();
    this.mode = mode;
    this.job = job;
    this.spec = clone(spec || BLANK);
    this.spec.constraints = this.spec.constraints || [];
    this.spec.workload = this.spec.workload || { type: 'service' };
    if (mode === 'new' && !this.spec.name) this.spec.name = uniqueName('job', this.taken());
    this.preset = mode === 'new' ? (PRESETS.find((p) => this.spec.name.startsWith(p.spec.name))?.key || 'blank') : null;
    this.start = delay > 0 ? { kind: 'in', secs: delay, at: '' } : { kind: 'now', secs: 30, at: '' };
    this.back = document.activeElement;

    this.el = h('section', { class: 'drawer', role: 'dialog', 'aria-label': mode === 'new' ? 'schedule a job' : `edit ${this.spec.name}` });
    this.el.innerHTML = this.html();
    this.dock.append(this.el);
    this.wire();
    this.refresh();
    this.shell.setMode('form');
    const first = mode === 'new' ? $('[data-group="preset"] [aria-checked="true"]', this.el) : $('[data-group="prio"] [aria-checked="true"]', this.el);
    (first || $('input', this.el))?.focus();
  }

  close(restore = true) {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    this.shell.setMode('nav');
    if (restore) this.shell.focusPanel();
  }

  taken() {
    return (this.shell.model?.jobs || []).map((j) => j.name);
  }

  limits() {
    const ms = (this.shell.model?.machines || []).filter((m) => m.up);
    const raw = this.shell.model?.raw;
    return {
      cpu: Math.max(0, ...ms.map((m) => m.capacity.cpu)),
      ram: Math.max(0, ...ms.map((m) => m.capacity.ram)),
      freeCpu: raw ? raw.capacity.cpu - raw.allocated.cpu : 0,
      freeRam: raw ? raw.capacity.ram - raw.allocated.ram : 0,
      attrs: [...new Set(ms.flatMap((m) => Object.entries(m.attributes || {}).map(([k, v]) => `${k}:${v}`)))].sort(),
    };
  }

  // ---- markup ----------------------------------------------------------------------------------

  group(name, options, current, label) {
    return `<span class="ctl" role="radiogroup" aria-label="${esc(label)}" data-group="${name}">${options.map(([v, text]) => `
      <button type="button" class="opt" role="radio" data-v="${esc(v)}" aria-checked="${String(v) === String(current)}" tabindex="${String(v) === String(current) ? 0 : -1}">${esc(text)}</button>`).join('')}</span>`;
  }

  stepper(name, value, { step, min, max, cls = 'narrow', unit = '' }) {
    return `<button type="button" class="step" data-step="${name}" data-d="-${step}" aria-label="less ${name}">−</button><input type="number" class="${cls}" name="${name}" value="${value}" step="${step}" min="${min}" max="${max}" aria-label="${name}"><button type="button" class="step" data-step="${name}" data-d="${step}" aria-label="more ${name}">+</button>${unit ? ` <span class="mute">${unit}</span>` : ''}`;
  }

  html() {
    const s = this.spec, w = s.workload, lim = this.limits();
    const isNew = this.mode === 'new';
    const cons = s.constraints[0];
    const consOpts = [['none', 'none'], ...lim.attrs.map((a) => [a, a])];
    if (cons && !lim.attrs.includes(`${cons.key}:${cons.value}`)) consOpts.push([`${cons.key}:${cons.value}`, `${cons.key}:${cons.value}`]);
    const title = isNew ? 'schedule a job' : `edit ${esc(s.name)} · job ${this.job.id}`;
    return `
      <h2 class="ptitle"><span class="name">${title}</span><span class="spacer"></span><span class="meta">⇥ next field · ←→ choose · ⏎ ${isNew ? 'schedule' : 'apply'} · esc cancel</span></h2>
      <div class="dscroll">
      <div class="form">
        ${isNew ? `<span class="lab">start from</span>${this.group('preset', [...PRESETS.map((p) => [p.key, p.label]), ['blank', 'blank']], this.preset, 'preset')}
        <span class="help" data-help="preset"></span>` : ''}
        <span class="lab">name</span><span class="ctl">${isNew ? `<input type="text" class="wide" name="name" value="${esc(s.name)}" aria-label="job name" spellcheck="false">` : `<b>${esc(s.name)}</b><span class="mute">(names cannot change)</span>`}</span>
        <span class="error" data-err="name" hidden></span>
        <span class="lab">priority</span><span class="ctl">${this.group('prio', BAND_OPTS.map(([n, v]) => [v, `${n}`]), BAND_OPTS.find(([, v]) => v === s.priority)?.[1] ?? '', 'priority band')}<input type="number" class="narrow" name="priority" value="${s.priority}" min="0" max="999" aria-label="priority number"></span>
        <span class="help" data-help="prio"></span>
        <span class="lab">type</span>${this.group('type', [['service', 'service'], ['batch', 'batch']], s.type, 'job type')}
        <span class="help">${'services are restarted when they crash; batch jobs run to completion'}</span>
        <span class="lab">workload</span><span class="ctl">${this.group('work', Object.keys(WORKLOADS).map((k) => [k, k === 'service' ? 'long-running' : k]), w.type, 'workload')}
          <span data-show="dur">for ${this.stepper('duration', w.duration || 60, { step: 10, min: 1, max: 86400, unit: 's' })}</span>
          <span data-show="threads">threads ${this.stepper('threads', w.threads || 1, { step: 1, min: 1, max: 16 })}</span>
          <span data-show="alloc">allocate ${this.stepper('alloc', w.mb || 100, { step: 16, min: 1, max: 65536, unit: 'MB' })}</span></span>
        <span class="help" data-help="work"></span>
        <span class="lab">size</span><span class="ctl">tasks ${this.stepper('tasks', s.tasks, { step: 1, min: 1, max: 200 })} &nbsp;cpu ${this.stepper('cpu', s.cpu, { step: 0.05, min: 0.05, max: 64 })} &nbsp;ram ${this.stepper('ram', s.ram_mb, { step: 16, min: 1, max: 1048576, unit: 'MB' })}</span>
        <span class="help fitnote" data-help="fit"></span>
        <span class="error" data-err="size" hidden></span>
        <span class="lab">placement</span><span class="ctl"><button type="button" class="opt" role="switch" data-toggle="distinct" aria-checked="${!!s.distinct}">spread: at most one task per machine</button></span>
        <span class="lab">constraint</span><span class="ctl">${this.group('cons', consOpts, cons ? `${cons.key}:${cons.value}` : 'none', 'constraint')}
          <span data-show="hard">${this.group('hard', [['hard', 'must'], ['soft', 'prefer']], cons && !cons.hard ? 'soft' : 'hard', 'constraint strength')}</span></span>
        <span class="help">only machines with this attribute (must), or prefer them when possible</span>
        ${isNew ? `<span class="lab">start</span><span class="ctl">${this.group('when', [['now', 'now'], ['in', 'in'], ['at', 'at']], this.start.kind, 'start time')}
          <span data-show="in"><input type="number" class="narrow" name="in" value="${this.start.secs}" min="1" aria-label="seconds from now"> <span class="mute">s</span></span>
          <span data-show="at"><input type="text" class="narrow" name="at" value="${esc(this.start.at || nextQuarter())}" placeholder="14:30" aria-label="time of day"></span></span>
          <span class="error" data-err="start" hidden></span>` : ''}
        <span class="lab">user</span><span class="ctl"><input type="text" name="user" value="${esc(s.user || 'you')}" aria-label="user" spellcheck="false"><span class="mute">fair share is per user</span></span>
      </div>
      <div class="impact" data-impact hidden></div>
      <div class="equiv" data-equiv></div>
      <div class="dlg-foot"><span class="grow dim" data-status></span>
        <button type="button" class="btn" data-act="cancel"><kbd>esc</kbd> cancel</button>
        <button type="button" class="btn primary" data-act="submit"><kbd>⏎</kbd> ${isNew ? 'schedule' : 'apply'}</button></div>
      </div>`;
  }

  // ---- behaviour -------------------------------------------------------------------------------

  wire() {
    const el = this.el;
    el.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-group] .opt');
      if (opt) return this.pick(opt.closest('[data-group]').dataset.group, opt.dataset.v, opt);
      const tog = e.target.closest('[data-toggle]');
      if (tog) {
        this.spec.distinct = !this.spec.distinct;
        tog.setAttribute('aria-checked', String(this.spec.distinct));
        return this.refresh();
      }
      const st = e.target.closest('[data-step]');
      if (st) {
        const input = $(`input[name="${st.dataset.step}"]`, el);
        const d = Number(st.dataset.d);
        const v = Math.round((Number(input.value || 0) + d) * 100) / 100;
        input.value = String(Math.max(Number(input.min || 0), v));
        return this.read();
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') this.close();
      if (act === 'submit') this.submit();
    });
    el.addEventListener('input', () => this.read());
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        return this.close();
      }
      const opt = e.target.closest?.('[data-group] .opt');
      if (opt && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        const opts = $$('.opt', opt.closest('[data-group]'));
        const i = (opts.indexOf(opt) + (e.key === 'ArrowRight' ? 1 : opts.length - 1)) % opts.length;
        opts[i].focus();
        return this.pick(opt.closest('[data-group]').dataset.group, opts[i].dataset.v, opts[i]);
      }
      if (e.key === 'Enter' && !e.target.closest('.btn, .step')) {
        e.preventDefault();
        e.stopPropagation();
        this.submit();
      }
      e.stopPropagation(); // the form owns the keyboard while it is open
    });
  }

  pick(group, v, opt) {
    const box = opt.closest('[data-group]');
    for (const o of $$('.opt', box)) {
      const on = o === opt;
      o.setAttribute('aria-checked', String(on));
      o.tabIndex = on ? 0 : -1;
    }
    const s = this.spec;
    switch (group) {
      case 'preset': {
        this.preset = v;
        const p = PRESETS.find((x) => x.key === v);
        const fresh = p ? clone(p.spec) : clone(BLANK);
        fresh.name = uniqueName(p ? p.spec.name : 'job', this.taken());
        fresh.user = s.user || 'you';
        this.spec = { ...fresh, constraints: fresh.constraints || [] };
        const focusKey = v;
        this.el.innerHTML = this.html();
        this.refresh();
        $(`[data-group="preset"] [data-v="${focusKey}"]`, this.el)?.focus();
        return;
      }
      case 'prio':
        s.priority = Number(v);
        $('input[name="priority"]', this.el).value = v;
        break;
      case 'type':
        s.type = v;
        break;
      case 'work': {
        const old = s.workload;
        s.workload = v === 'service' ? { type: v } : { type: v, duration: old.duration || 60 };
        if (v === 'cpu') s.workload.threads = old.threads || 1;
        if (v === 'mem') s.workload.mb = old.mb || 100;
        break;
      }
      case 'cons':
      case 'hard': {
        const pair = $('[data-group="cons"] [aria-checked="true"]', this.el).dataset.v;
        const hard = $('[data-group="hard"] [aria-checked="true"]', this.el).dataset.v === 'hard';
        const [key, ...rest] = pair.split(':');
        s.constraints = pair === 'none' ? [] : [{ key, value: rest.join(':'), hard }];
        break;
      }
      case 'when':
        this.start.kind = v;
        break;
    }
    this.read();
  }

  // Reads the text/number inputs into the spec, then refreshes the derived parts.
  read() {
    const s = this.spec, el = this.el;
    const val = (n) => $(`input[name="${n}"]`, el)?.value;
    if (this.mode === 'new') s.name = (val('name') || '').trim();
    s.user = (val('user') || '').trim() || 'you';
    const prio = Number(val('priority'));
    if (Number.isFinite(prio)) {
      s.priority = prio;
      const box = $('[data-group="prio"]', el);
      for (const o of $$('.opt', box)) o.setAttribute('aria-checked', String(Number(o.dataset.v) === prio));
    }
    s.tasks = Number(val('tasks'));
    s.cpu = Number(val('cpu'));
    s.ram_mb = Number(val('ram'));
    if (s.workload.type !== 'service') s.workload.duration = Number(val('duration'));
    if (s.workload.type === 'cpu') s.workload.threads = Number(val('threads'));
    if (s.workload.type === 'mem') s.workload.mb = Number(val('alloc'));
    if (this.mode === 'new') {
      this.start.secs = Number(val('in'));
      this.start.at = val('at') || '';
    }
    this.refresh();
  }

  validate() {
    const s = this.spec, lim = this.limits(), e = {};
    if (this.mode === 'new') {
      if (!NAME_RE.test(s.name)) e.name = 'name: 1-40 letters, digits, - _ . (no spaces)';
      else if (this.taken().includes(s.name)) e.name = `a job named "${s.name}" already exists: try ${uniqueName(s.name, this.taken())}`;
    }
    if (!Number.isInteger(s.tasks) || s.tasks < 1 || s.tasks > 200) e.size = 'tasks must be a whole number from 1 to 200';
    else if (!(s.cpu > 0)) e.size = 'cpu must be more than 0 cores';
    else if (lim.cpu && s.cpu > lim.cpu) e.size = `cpu ${num(s.cpu)} is more than the biggest machine (${num(lim.cpu)} cores): no task could ever be placed`;
    else if (!(s.ram_mb >= 1)) e.size = 'ram must be at least 1 MB';
    else if (lim.ram && s.ram_mb > lim.ram) e.size = `ram ${s.ram_mb} MB is more than the biggest machine (${lim.ram} MB)`;
    else if (s.workload.type !== 'service' && !(s.workload.duration > 0)) e.size = 'the workload needs a run time of at least 1 second';
    else if (s.workload.type === 'cpu' && !(s.workload.threads >= 1 && s.workload.threads <= 16)) e.size = 'threads must be 1 to 16';
    else if (!(s.priority >= 0 && s.priority <= 999)) e.size = 'priority must be 0 to 999';
    if (this.mode === 'new') {
      const d = this.delay();
      if (d.error) e.start = d.error;
    }
    return e;
  }

  delay() {
    if (this.start.kind === 'now') return { value: 0 };
    if (this.start.kind === 'in') {
      const v = this.start.secs;
      return v > 0 && v <= 7 * 86400 ? { value: v } : { error: 'start: seconds from now must be between 1 and 604800' };
    }
    return parseWhen(`at ${this.start.at}`);
  }

  refresh() {
    const el = this.el, s = this.spec, w = s.workload, lim = this.limits();
    for (const k of ['dur', 'threads', 'alloc']) {
      const show = k === 'dur' ? w.type !== 'service' : k === 'threads' ? w.type === 'cpu' : w.type === 'mem';
      const span = $(`[data-show="${k}"]`, el);
      if (span) span.hidden = !show;
    }
    for (const k of ['in', 'at']) {
      const span = $(`[data-show="${k}"]`, el);
      if (span) span.hidden = this.start.kind !== k;
    }
    $('[data-show="hard"]', el).hidden = !s.constraints.length;
    const help = (k, t) => { const x = $(`[data-help="${k}"]`, el); if (x) x.textContent = t; };
    help('preset', this.preset && this.preset !== 'blank' ? PRESETS.find((p) => p.key === this.preset)?.blurb || '' : 'start from scratch');
    help('prio', `${bandOf(s.priority)} band · higher priority can preempt lower; prod (200+) never preempts prod`);
    help('work', WORKLOADS[w.type] || '');
    const need = { cpu: s.cpu * s.tasks, ram: s.ram_mb * s.tasks };
    help('fit', lim.cpu
      ? `needs ${num(need.cpu)} cpu · ${Math.round(need.ram)} MB in total · free now ${num(Math.max(0, lim.freeCpu))} cpu · ${Math.round(Math.max(0, lim.freeRam))} MB · biggest machine ${num(lim.cpu)} cpu / ${lim.ram} MB`
      : 'no machines have registered yet');

    const errs = this.validate();
    for (const k of ['name', 'size', 'start']) {
      const x = $(`[data-err="${k}"]`, el);
      if (!x) continue;
      x.hidden = !errs[k];
      x.textContent = errs[k] ? `✗ ${errs[k]}` : '';
    }
    for (const n of ['name']) $(`input[name="${n}"]`, el)?.setAttribute('aria-invalid', String(!!errs[n]));
    const nErr = Object.keys(errs).length;

    // equivalent command + edit impact
    const equiv = $('[data-equiv]', el);
    let line;
    if (this.mode === 'new') {
      const d = this.delay();
      const start = this.start.kind === 'in' ? ` start=${this.start.secs}s` : this.start.kind === 'at' ? ` start=${this.start.at}` : '';
      line = `schedule ${s.name || '<name>'} ${toArgs(s).join(' ')}${d.value ? start : ''} -y`;
    } else {
      const args = toArgs(s, specOf(this.job));
      line = args.length ? `edit ${s.name} ${args.join(' ')} -y` : `edit ${s.name}   (nothing changed yet)`;
      const impact = $('[data-impact]', el);
      impact.hidden = false;
      const effect = editEffect(this.job, patchOf(this.job, s));
      impact.innerHTML = `<span class="mute">effect:</span> <span class="${/restart|stopped/.test(effect) ? 'warn' : 'ok'}">${esc(effect)}</span>`;
    }
    equiv.innerHTML = `<span class="mute">same as typing:</span> <span class="p">❯</span> ${esc(line)}`;
    const status = $('[data-status]', el);
    status.innerHTML = nErr ? `<span class="err">✗ fix ${nErr} problem${nErr > 1 ? 's' : ''} above</span>` : `<span class="ok">✓ ready</span>`;
    $('[data-act="submit"]', el).disabled = nErr > 0;
  }

  async submit() {
    this.read();
    const errs = this.validate();
    if (Object.keys(errs).length) {
      const first = Object.keys(errs)[0];
      this.shell.fail(errs[first]);
      return;
    }
    const spec = clone(this.spec);
    const ok = this.mode === 'new'
      ? await this.shell.submitJob(spec, this.delay().value || 0)
      : await this.shell.applyEdit(this.job, spec);
    if (ok) this.close();
  }

  // Keeps the fit note current while the form is open.
  tick() {
    if (this.el) this.refresh();
  }
}

function nextQuarter() {
  const d = new Date(Date.now() + 15 * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(Math.floor(d.getMinutes() / 15) * 15).padStart(2, '0')}`;
}

