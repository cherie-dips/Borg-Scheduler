// 1 home: the whole cell at a glance. Cell meters, jobs grouped by status with progress,
// machines one per line, and the live log.

import { eventLine, jobRow, machineLine } from './common.js';
import { PRESETS } from '../core/presets.js';
import { GROUPS } from '../core/model.js';
import { segbar, sparkline } from '../ui/widgets.js';
import { esc, num } from '../lib/format.js';
import { cols, patch } from '../lib/dom.js';

const GROUP_LABEL = { running: 'running', queued: 'queued', completed: 'completed', failed: 'failed' };
const PER_GROUP = { running: 99, queued: 99, completed: 5, failed: 5 };

export default {
  id: 'home',
  title: 'home',
  panels: [
    { id: 'jobs', title: 'jobs' },
    { id: 'cell', title: 'cell' },
    { id: 'machines', title: 'machines' },
    { id: 'log', title: 'live log' },
  ],
  ticks: true,

  render(shell, P) {
    renderCell(shell, P.cell);
    renderJobs(shell, P.jobs);
    renderMachines(shell, P.machines);
    renderLog(shell, P.log);
  },

  list(shell, panel) {
    const m = shell.model;
    if (!m) return null;
    if (panel === 'jobs') return { kind: 'job', ids: visibleJobs(m).map((j) => j.id) };
    if (panel === 'machines') return { kind: 'machine', ids: m.machines.map((x) => x.id) };
    return null;
  },

  open(shell, panel, id) {
    if (panel === 'jobs') shell.setView('jobs', { select: id });
    if (panel === 'machines') shell.setView('machines', { select: id });
  },

  hints(shell) {
    const sel = shell.selectedJob();
    return [['n', 'new job', 'new'], ...(sel ? [['e', 'edit', 'edit'], ['r', 'resched', 'resched'], ['d', 'delete', 'delete'], ['⏎', 'open', 'open']] : [])];
  },
};

function visibleJobs(m) {
  return GROUPS.flatMap((g) => m.groups[g].slice(0, PER_GROUP[g]));
}

function renderCell(shell, p) {
  const m = shell.model;
  if (!m) return patch(p.body, `<p class="mute">waiting for the borgmaster…</p>`);
  const r = m.raw, c = m.counts, hist = shell.store.history;
  const w = Math.max(8, cols(p.body) - 6 - 1 - 16);
  const cpuA = r.capacity.cpu ? r.allocated.cpu / r.capacity.cpu : 0;
  const ramA = r.capacity.ram ? r.allocated.ram / r.capacity.ram : 0;
  const prodCpu = m.machines.reduce((s, x) => s + (x.up ? x.allocated_prod.cpu : 0), 0) / (r.capacity.cpu || 1);
  const prodRam = m.machines.reduce((s, x) => s + (x.up ? x.allocated_prod.ram : 0), 0) / (r.capacity.ram || 1);
  const used = hist.cpuUsed[hist.cpuUsed.length - 1] || 0;
  const dots = m.machines.map((x) => `<button type="button" class="dotbtn ${x.up ? 'live' : 'err'}" data-machine="${x.id}" title="${esc(x.name)} ${x.status}" aria-label="${esc(x.name)} ${x.status}">${x.up ? '●' : '○'}</button>`).join('');
  const s = r.scheduler || {};
  patch(p.body, `
    <div class="meter"><span class="lbl">nodes</span><span>${dots || '<span class="mute">none yet</span>'}</span><span>${c.machinesUp}/${c.machines} up</span></div>
    <div class="meter"><span class="lbl">cpu</span>${segbar([{ frac: prodCpu, cls: 'prod' }, { frac: cpuA - prodCpu, cls: 'nonprod' }], w, { marker: used })}<span>${Math.round(cpuA * 100)}% alloc</span></div>
    <div class="meter"><span class="lbl"></span>${sparkline(hist.cpuUsed, w)}<span class="mute">used ${Math.round(used * 100)}%</span></div>
    <div class="meter"><span class="lbl">ram</span>${segbar([{ frac: prodRam, cls: 'prod' }, { frac: ramA - prodRam, cls: 'nonprod' }], w)}<span>${Math.round(ramA * 100)}% alloc</span></div>
    <div class="meter"><span class="lbl">tasks</span><span class="counters"><span class="live">▶ ${c.running}</span><span class="warn">◌ ${c.queued}</span><span class="done">✓ ${c.done}</span><span class="err">✗ ${c.failed}</span></span><span></span></div>
    <div class="meter"><span class="lbl">sched</span><span class="dim">${esc(r.policy)} · ${s.elapsed_ms != null ? `${num(s.elapsed_ms, 3)} ms pass · ${s.placed} placed · ${s.preempted} preempted` : 'idle'}</span><span></span></div>
    <p class="mute" style="margin-top:.2em"><span class="b-production">█</span> prod <span class="b-batch">█</span> non-prod <span>┃</span> actual use</p>`);
}

function renderJobs(shell, p) {
  const m = shell.model;
  if (!m) return patch(p.body, '');
  p.meta(`${m.jobs.length} job${m.jobs.length === 1 ? '' : 's'}`);
  if (!m.jobs.length) {
    const presets = PRESETS.map((x) => `<button type="button" class="preset" data-act="preset" data-preset="${x.key}"><span class="pn">▸ ${esc(x.label)}</span><span class="pb">${esc(x.blurb)}</span></button>`).join('');
    return patch(p.body, `<div class="empty-state">
      <p class="es-title">No jobs yet: the cell is idle. Let's assimilate some workloads.</p>
      <p>Pick one below, press <kbd>n</kbd> for the full form, or type <kbd>:</kbd> then <b>schedule</b>.</p>
      <div class="presets">${presets}</div>
      <div class="es-actions"><button type="button" class="btn primary" data-act="new"><kbd>n</kbd> new job…</button>
        <button type="button" class="btn" data-act="tour">▸ guided tour (schedules a short demo)</button>
        <button type="button" class="btn" data-act="help"><kbd>?</kbd> help</button></div></div>`);
  }
  const cw = cols(p.body);
  const nameW = Math.min(18, Math.max(8, ...m.jobs.map((j) => j.name.length)));
  const barW = Math.max(8, Math.min(28, cw - 8 - nameW - 10 - 30));
  const sel = shell.sel.job, frame = shell.frame;
  let html = '<table class="tbl"><tbody>';
  for (const g of GROUPS) {
    const jobs = m.groups[g];
    if (!jobs.length) continue;
    html += `<tr><td colspan="4" class="group"><span class="gname">${GROUP_LABEL[g].toUpperCase()}</span> ${jobs.length}</td></tr>`;
    for (const j of jobs.slice(0, PER_GROUP[g])) html += jobRow(j, { sel: j.id === sel, nameW, barW, frame });
    if (jobs.length > PER_GROUP[g]) html += `<tr><td colspan="4" class="mute"><button type="button" class="linkbtn" data-act="view" data-view="jobs" data-filter="${g}">… ${jobs.length - PER_GROUP[g]} more ${g} (2 jobs)</button></td></tr>`;
  }
  patch(p.body, `${html}</tbody></table>`);
}

function renderMachines(shell, p) {
  const m = shell.model;
  if (!m) return patch(p.body, '');
  p.meta(`${m.counts.machinesUp}/${m.counts.machines} up`);
  if (!m.machines.length) return patch(p.body, `<p class="mute">No Borglets have registered. Start the cell: <b>docker compose up -d</b></p>`);
  const barW = Math.max(6, cols(p.body) - 2 - 12 - 1 - 10 - 9);
  patch(p.body, m.machines.map((x) => machineLine(x, { sel: x.id === shell.sel.machine, hist: shell.store.history.machines.get(x.id), barW })).join(''));
}

function renderLog(shell, p) {
  const ev = shell.store.events;
  p.meta(`${ev.length} events · 4 for all`);
  if (!ev.length) return patch(p.body, `<p class="mute">Every scheduling decision appears here as it happens: placements, preemptions, failures.</p>`);
  const rows = Math.max(3, Math.floor(p.body.clientHeight / (parseFloat(getComputedStyle(p.body).lineHeight) || 20)));
  const html = ev.slice(-rows * 2).map((e) => eventLine(e)).join('');
  patch(p.body, html);
  p.body.scrollTop = p.body.scrollHeight;
}
