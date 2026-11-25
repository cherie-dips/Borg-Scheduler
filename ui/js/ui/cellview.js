// Drawing the cell: the queue of tasks waiting for a machine, then one block per machine with
// its state, a CPU meter, a memory meter and its tasks. Every task is a chip with a stable id,
// so when a redraw moves it (placed from the queue, preempted back into it, moved off a failed
// machine) it slides from its old place to the new one.
//
// Colour is used for live things only: a task has the colour of its priority band, and a
// machine's state is green, yellow or red. Everything else is white on black.

import { PLACED, bandClass } from '../core/model.js';
import { esc, num } from '../lib/format.js';

const STATE = { starting: 'starting', installing: 'starting', pending: 'queued', waiting: 'held' };
const byPriority = (a, b) => b.priority - a.priority || a.job - b.job || a.index - b.index;
const mb = (v) => String(Math.round(v));

// "demo-tour-analytics" -> "analytics", "demo-quota" -> "quota", "web" -> "web"
function shortName(job) {
  const m = /^demo-[a-z]+-(.+)$/.exec(job);
  return m ? m[1] : job.replace(/^demo-/, '');
}

function taskTip(t) {
  const parts = [`${t.job_name} task ${t.index}`, t.state === 'installing' ? 'starting' : t.state];
  if (PLACED.has(t.state) && t.machine_name && t.machine_name !== '-') parts.push(`on ${t.machine_name}`);
  parts.push(`asks for ${num(t.cpu)} CPU and ${mb(t.ram_mb)} MB`);
  if (t.state === 'running') parts.push(`uses ${num(t.cpu_usage)} CPU and ${mb(t.mem_mb)} MB`);
  if (t.reason && !PLACED.has(t.state)) parts.push(t.reason);
  if (t.healthy === 0) parts.push('failing its health check');
  if (t.outdated) parts.push('still runs the old version of its job');
  if (t.avoid?.length) parts.push(`kept off ${t.avoid.join(', ')}`);
  return parts.join(' · ');
}

export function chip(t, ctx = {}) {
  const cls = ['chip', bandClass(t.band), STATE[t.state] || ''];
  const extra = [];
  if (t.healthy === 0 && t.state === 'running') {
    cls.push('sick');
    extra.push('failing');
  }
  if (ctx.dimOthers && !t.job_name.startsWith(ctx.prefix)) cls.push('other');
  if (ctx.focusJob != null && t.job === ctx.focusJob) cls.push('focus');
  if (t.outdated) extra.push('old');
  if (t.state === 'waiting' && t.release > 0 && ctx.now) extra.push(`${Math.max(0, Math.ceil(t.release - ctx.now))}s`);
  return `<span class="${cls.filter(Boolean).join(' ')}" data-tid="${t.id}" data-state="${t.state}" title="${esc(taskTip(t))}">${esc(shortName(t.job_name))}/${t.index}${extra.length ? ` <small>${extra.join(' ')}</small>` : ''}</span>`;
}

// A task, or an alloc with the tasks that run inside it.
function group(g, ctx) {
  const t = g.task;
  if (t.type !== 'alloc') return chip(t, ctx);
  const other = ctx.dimOthers && !t.job_name.startsWith(ctx.prefix) ? ' other' : '';
  const tip = `An alloc: ${num(t.cpu)} CPU and ${mb(t.ram_mb)} MB set aside on this machine for the tasks inside it`;
  return `<span class="alloc ${bandClass(t.band)}${other}" data-tid="${t.id}" title="${esc(tip)}"><b>ALLOC ${esc(shortName(t.job_name))}/${t.index}</b>${g.inside.map((x) => chip(x, ctx)).join('') || '<i>empty</i>'}</span>`;
}

// ---- the queue -----------------------------------------------------------------------------------

export function queueRow(model, ctx, { max = 18 } = {}) {
  const queued = model.unplaced.filter((t) => t.state === 'pending').sort(byPriority);
  const held = model.unplaced.filter((t) => t.state === 'waiting').sort(byPriority);
  const all = queued.concat(held);
  const body = all.length
    ? `${all.slice(0, max).map((t) => chip(t, ctx)).join('')}${all.length > max ? `<span class="more">+${all.length - max} more</span>` : ''}`
    : '<span class="none">empty</span>';
  return `<div class="queue"><span class="k" title="Tasks waiting for a machine">QUEUE</span><div class="chips">${body}</div></div>`;
}

// ---- machines ------------------------------------------------------------------------------------

// state -> [colour, word, what to say next to it]
const STATUS = {
  up: ['ok', 'UP', ''],
  down: ['bad', 'DOWN', 'not answering: its tasks go back to the queue'],
  draining: ['warn', 'DRAINING', 'maintenance: its tasks are moving away'],
  drained: ['warn', 'DRAINED', 'empty, ready for maintenance'],
};

export const machineState = (m) => {
  const [tone, word] = STATUS[m.state] || STATUS.up;
  return `<span class="state ${tone}"><i class="dot"></i>${word}</span>`;
};

export const attributes = (m) => Object.entries(m.attributes || {})
  .map(([k, v]) => (v === 'true' ? k : v === 'false' ? '' : `${k} ${v}`)).filter(Boolean).join(' · ');

// One meter: a bar with one segment per task in its band's colour, then "asked/capacity".
// `resv` (with resource reclamation on) marks how much is reserved after reclaiming.
export function meter(label, m, key, ctx) {
  const tasks = m.groups.map((g) => g.task);
  const cap = m[key].cap, asked = m[key].asked;
  const reserved = (m.reserved || m.allocated || {})[key] ?? asked;
  const used = m.usage?.[key] || 0;
  const fmt = key === 'cpu' ? (v) => num(v, 2) : mb;
  const unit = key === 'cpu' ? '' : ' MB';
  const scale = Math.max(cap, asked, 1e-9);
  const segs = tasks.map((t) => `<i class="${bandClass(t.band)}" style="width:${(100 * (key === 'cpu' ? t.cpu : t.ram_mb)) / scale}%"></i>`).join('');
  const over = asked > cap + 1e-9;
  const capMark = over ? `<b class="cap" style="left:${(100 * cap) / scale}%"></b>` : '';
  const showResv = ctx.reclaim && reserved < asked - 1e-6;
  const resvMark = showResv ? `<b class="resv" style="left:${Math.min(99.4, (100 * reserved) / scale)}%"></b>` : '';
  const tip = `${label}: tasks ask for ${fmt(asked)} of ${fmt(cap)}${unit}; ${fmt(used)}${unit} in use${showResv ? `; ${fmt(reserved)}${unit} reserved after reclaiming` : ''}`;
  return `<div class="u ${key}" title="${esc(tip)}"><span class="k">${label}</span><div class="bar">${segs}${capMark}${resvMark}</div><span class="v${over ? ' over' : ''}">${fmt(asked)}/${fmt(cap)}${unit}</span></div>`;
}

function machineBlock(m, ctx) {
  const note = (STATUS[m.state] || STATUS.up)[2] || attributes(m);
  return `<div class="m ${m.state}${ctx.focusMachine === m.id ? ' focus' : ''}" data-mid="${m.id}">
    <div class="m-h"><b class="m-n">${esc(m.name)}</b>${machineState(m)}<span class="m-x" title="${esc(note)}">${esc(note)}</span></div>
    <div class="m-u">${meter('CPU', m, 'cpu', ctx)}${meter('MEM', m, 'ram', ctx)}</div>
    <div class="chips">${m.groups.map((g) => group(g, ctx)).join('') || '<span class="none">no tasks</span>'}</div>
  </div>`;
}

export function machineList(model, ctx) {
  return `<div class="machines">${model.machines.map((m) => machineBlock(m, ctx)).join('')}</div>`;
}

// ---- redrawing with motion ---------------------------------------------------------------------

const EASE = 'cubic-bezier(.2,.8,.2,1)';

// Replaces the content of `root`, then slides every task chip from where it was to where it is
// now; new chips fade in, and chips that are gone fade out where they were.
export function swap(root, html, { animate = true } = {}) {
  const before = new Map();
  if (animate) {
    for (const el of root.querySelectorAll('[data-tid]')) {
      before.set(el.dataset.tid, { rect: el.getBoundingClientRect(), html: el.outerHTML, state: el.dataset.state, alloc: el.classList.contains('alloc') });
    }
  }
  root.innerHTML = html;
  if (!animate) return;
  const seen = new Set();
  for (const el of root.querySelectorAll('[data-tid]')) {
    const id = el.dataset.tid;
    seen.add(id);
    const old = before.get(id);
    if (!old) {
      el.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: EASE });
      continue;
    }
    const now = el.getBoundingClientRect();
    const dx = old.rect.left - now.left, dy = old.rect.top - now.top;
    if (Math.abs(dx) + Math.abs(dy) > 2) {
      el.style.position = 'relative';
      el.style.zIndex = '5';
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: Math.min(1000, 450 + Math.hypot(dx, dy) * 0.5), easing: EASE }).onfinish = () => {
        el.style.zIndex = '';
        el.style.position = '';
      };
    }
    if (old.state && old.state !== el.dataset.state) el.classList.add('ping');
  }
  const ghosts = document.getElementById('ghosts');
  for (const [id, old] of before) {
    if (seen.has(id) || old.alloc || !ghosts) continue;
    const wrap = document.createElement('div');
    wrap.innerHTML = old.html;
    const g = wrap.firstElementChild;
    if (!g) continue;
    Object.assign(g.style, { left: `${old.rect.left}px`, top: `${old.rect.top}px` });
    ghosts.append(g);
    g.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-10px)' }], { duration: 600, easing: 'ease-in', fill: 'forwards' })
      .onfinish = () => g.remove();
  }
}
