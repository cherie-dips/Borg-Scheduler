// 2 jobs: every job in a filterable list; the selected job's spec, timeline and tasks.

import { jobMatches, jobRow } from './common.js';
import { taskProgress } from '../core/model.js';
import { BADGE, TASK_BADGE, badge, band, jobProgress, keyBtn, shortReason, simpleBar } from '../ui/widgets.js';
import { ago, clock, dur, esc, fit, num } from '../lib/format.js';
import { cols, patch } from '../lib/dom.js';

export default {
  id: 'jobs',
  title: 'jobs',
  panels: [
    { id: 'list', title: 'jobs' },
    { id: 'detail', title: 'job' },
  ],
  ticks: true,

  render(shell, P) {
    renderList(shell, P.list);
    renderDetail(shell, P.detail);
  },

  list(shell, panel) {
    if (panel !== 'list' || !shell.model) return null;
    return { kind: 'job', ids: filtered(shell).map((j) => j.id) };
  },

  open(shell, panel) {
    if (panel === 'list') shell.focusPanel('detail');
  },

  hints(shell) {
    const sel = shell.selectedJob();
    return [['n', 'new job', 'new'], ...(sel ? [['e', 'edit', 'edit'], ['r', 'resched', 'resched'], ['d', 'delete', 'delete']] : []), ['/', 'filter', 'filter']];
  },
};

const filtered = (shell) => shell.model.jobs.filter(jobMatches(shell.filter.jobs));

function renderList(shell, p) {
  const m = shell.model;
  if (!m) return patch(p.body, '');
  const f = shell.filter.jobs;
  const jobs = filtered(shell);
  p.meta(f ? `${jobs.length}/${m.jobs.length} match "${f}" · esc clears` : `${m.jobs.length} · / filter`);
  if (!m.jobs.length) {
    return patch(p.body, `<div class="empty-state"><p class="es-title">No jobs yet.</p>
      <p>Press <kbd>n</kbd> or <button type="button" class="linkbtn" data-act="new">click here</button> to schedule one, or go <button type="button" class="linkbtn" data-act="view" data-view="home">home</button> for one-click presets.</p></div>`);
  }
  if (!jobs.length) {
    return patch(p.body, `<div class="empty-state"><p class="es-title">No jobs match "${esc(f)}".</p>
      <p>Filters match name, user, status (running, queued, failed …) and band. <button type="button" class="linkbtn" data-act="clear-filter">Clear the filter</button> or press <kbd>esc</kbd>.</p></div>`);
  }
  const nameW = Math.min(18, Math.max(6, ...jobs.map((j) => j.name.length)));
  const barW = Math.max(6, Math.min(24, cols(p.body) - 8 - nameW - 10 - 30));
  const rows = jobs.map((j) => jobRow(j, { sel: j.id === shell.sel.job, nameW, barW, frame: shell.frame })).join('');
  patch(p.body, `<table class="tbl"><thead><tr><th>state</th><th>name</th><th>priority</th><th>progress</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function workloadText(j) {
  const w = j.workload || {};
  const d = dur(w.duration);
  return {
    service: 'runs until stopped',
    sleep: `sleeps for ${d}`,
    cpu: `burns ${w.threads || 1} CPU thread${(w.threads || 1) > 1 ? 's' : ''} for ${d}`,
    mem: `grows to ${w.mb} MB, runs ${d}`,
    crash: `crashes after ${d}`,
  }[w.type] || w.type;
}

// Notes explain the states that need explaining; a healthy running task needs none.
const taskNote = (t) => (t.state === 'running' || /^(running in|package cached)/.test(t.reason) ? '' : shortReason(t.reason));

function taskCells(t, j, now, frame) {
  const d = j.duration;
  let prog;
  if (t.state === 'running') {
    const f = taskProgress(t, d, now);
    prog = f != null
      ? `${simpleBar(f, 10, 'fill live')} ${dur(now - t.started)} / ${dur(d)}`
      : `<span class="live">up ${dur(now - t.started)}</span>`;
  } else if (t.state === 'pending') prog = `<span class="warn"><span class="spin">${'▖▘▝▗'[frame % 4]}</span> queued</span>`;
  else if (t.state === 'waiting') prog = `<span class="info">starts in ${dur(Math.max(0, t.release - now))}</span>`;
  else if (t.state === 'installing' || t.state === 'starting') prog = `<span class="info">${t.state}…</span>`;
  else if (t.state === 'finished') prog = `${simpleBar(1, 10, 'fill done')} ${t.started ? dur(t.ended - t.started) : ''}`;
  else prog = `<span class="mute">ended ${clock(t.ended)}</span>`;
  const usage = t.state === 'running'
    ? `${num(t.cpu_usage)}/${num(t.cpu)} <span class="mute">cpu</span> ${Math.round(t.mem_mb)}/${t.ram_mb} <span class="mute">MB</span>`
    : `<span class="mute">${num(t.cpu)} cpu · ${t.ram_mb} MB</span>`;
  return `<td>${t.index}</td><td>${badge(t.state, TASK_BADGE)}</td>
    <td>${t.machine >= 0 ? `<button type="button" class="linkbtn" data-machine="${t.machine}">${esc(t.machine_name)}</button>` : '<span class="mute">—</span>'}</td>
    <td>${prog}</td><td>${usage}</td><td class="num">${t.restarts || ''}</td><td class="num">${t.preemptions || ''}</td>
    <td class="wrap mute">${esc(taskNote(t))}</td>`;
}

function renderDetail(shell, p) {
  const j = shell.selectedJob();
  if (!j) {
    p.title('job');
    p.meta('');
    return patch(p.body, `<div class="empty-state"><p class="es-title">No job selected.</p>
      <p>Pick one on the left with <kbd>↑</kbd><kbd>↓</kbd> or a click. Its tasks, machines, progress and history show up here.</p></div>`);
  }
  const now = shell.store.now();
  p.title(`${j.name}`);
  p.meta(`job ${j.id}${j.runs > 1 ? ` · run #${j.runs}` : ''} · e edit · r reschedule · d delete`);
  const cons = (j.constraints || []).map((c) => `${c.hard ? 'needs' : 'prefers'} ${esc(c.key)}=${esc(c.value)}`).join(', ');
  const timeline = [`submitted <b>${clock(j.submitted)}</b>`];
  if (j.start_at && j.status === 'waiting') timeline.push(`starts <b>${clock(j.start_at)}</b> (in ${dur(j.startsIn)})`);
  if (j.started_at) timeline.push(`first running <b>${clock(j.started_at)}</b>`);
  if (j.done && j.finished_at) timeline.push(`finished <b>${clock(j.finished_at)}</b>${j.elapsed ? ` (ran ${dur(j.elapsed)})` : ''}`);
  else if (j.uptime) timeline.push(`up <b>${dur(j.uptime)}</b>`);
  const words = { running: 'running', queued: 'waiting for room in the cell', waiting: 'scheduled for later', completed: 'completed', failed: 'failed', killed: 'stopped by a user' }[j.status];
  const tasks = j.taskList.map((t) => `<tr class="${t.state === 'failed' || t.state === 'oom' ? 'err' : ''}">${taskCells(t, j, now, shell.frame)}</tr>`).join('');
  const barW = Math.max(10, Math.min(40, cols(p.body) - 34));
  patch(p.body, `
    <dl class="kv">
      <dt>status</dt><dd>${badge(j.status, BADGE)} ${words}${j.reason && (j.status === 'queued' || j.status === 'failed') ? ` <span class="${j.status === 'failed' ? 'err' : 'warn'}">· ${esc(shortReason(j.reason))}</span>` : ''}</dd>
      <dt>progress</dt><dd>${jobProgress(j, barW)}</dd>
      <dt>priority</dt><dd>${band(j)} <span class="mute">· ${j.priority >= 200 ? 'production: never preempted by other prod work' : 'can be preempted by higher priorities'}</span></dd>
      <dt>spec</dt><dd>${j.tasks} × ${num(j.cpu)} cpu · ${j.ram_mb} MB · ${esc(j.type)} · ${esc(workloadText(j))}${j.distinct ? ' · one per machine' : ''}${cons ? ` · ${cons}` : ''}</dd>
      <dt>owner</dt><dd>${esc(j.user)}</dd>
      <dt>timeline</dt><dd class="timeline">${timeline.join(' → ')}</dd>
      ${j.restarts || j.preemptions ? `<dt>history</dt><dd>${j.restarts ? `${j.restarts} restart${j.restarts > 1 ? 's' : ''}` : ''}${j.restarts && j.preemptions ? ' · ' : ''}${j.preemptions ? `${j.preemptions} preemption${j.preemptions > 1 ? 's' : ''}` : ''}</dd>` : ''}
    </dl>
    <table class="tbl" style="margin-top:.6em"><thead><tr><th>#</th><th>state</th><th>machine</th><th>progress</th><th>usage / limit</th><th class="num" title="times restarted after a crash">restarts</th><th class="num" title="times preempted by higher-priority work">evicted</th><th>note</th></tr></thead>
      <tbody>${tasks}</tbody></table>
    <div class="actions">${keyBtn('e', 'edit', 'edit')}${keyBtn('r', j.done ? 'run again' : 'reschedule', 'resched')}${keyBtn('d', j.done ? 'remove' : 'kill / delete', 'delete')}${shell.canUndo() ? keyBtn('u', 'undo', 'undo') : ''}
      <span class="mute">submitted ${ago(now - j.submitted)}</span></div>`);
}
