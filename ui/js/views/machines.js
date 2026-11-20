// 3 machines: CPU/RAM per machine (prod vs non-prod, actual use), history, tasks; failures.

import { matcher } from './common.js';
import { TASK_BADGE, badge, band, keyBtn, segbar, sparkline } from '../ui/widgets.js';
import { ago, esc, fit, num } from '../lib/format.js';
import { cols, patch } from '../lib/dom.js';

export default {
  id: 'machines',
  title: 'machines',
  panels: [
    { id: 'list', title: 'machines' },
    { id: 'detail', title: 'machine' },
  ],
  ticks: false,

  render(shell, P) {
    renderList(shell, P.list);
    renderDetail(shell, P.detail);
  },

  list(shell, panel) {
    if (panel !== 'list' || !shell.model) return null;
    return { kind: 'machine', ids: filtered(shell).map((m) => m.id) };
  },

  open(shell, panel) {
    if (panel === 'list') shell.focusPanel('detail');
  },

  hints(shell) {
    const m = shell.selectedMachine();
    return [...(m && m.up ? [['f', 'fail machine', 'fail']] : []), ['/', 'filter', 'filter']];
  },
};

function filtered(shell) {
  const match = matcher(shell.filter.machines);
  return shell.model.machines.filter((m) => match(m.name, m.status, ...Object.entries(m.attributes || {}).map(([k, v]) => `${k}=${v} ${k}:${v}`)));
}

function renderList(shell, p) {
  const model = shell.model;
  if (!model) return patch(p.body, '');
  const ms = filtered(shell);
  p.meta(shell.filter.machines ? `${ms.length}/${model.machines.length} match "${shell.filter.machines}"` : `${model.counts.machinesUp}/${model.counts.machines} up · f fails one`);
  if (!model.machines.length) {
    return patch(p.body, `<div class="empty-state"><p class="es-title">No machines yet.</p><p>Borglets register themselves when they start: <b>docker compose up -d</b></p></div>`);
  }
  const w = Math.max(6, Math.min(16, Math.floor((cols(p.body) - 12 - 8 - 22 - 14) / 2)));
  const rows = ms.map((m) => {
    const sel = m.id === shell.sel.machine;
    const hist = shell.store.history.machines.get(m.id) || [];
    const attrs = Object.entries(m.attributes || {}).map(([k, v]) => `${k}=${v}`).join(' ');
    if (!m.up) {
      return `<tr class="row${sel ? ' sel' : ''}" data-machine="${m.id}"><td><span class="err strong">○ DOWN</span></td><td class="strong">${esc(m.name)}</td>
        <td colspan="3" class="err">no answer for 3 polls · its tasks were moved · last seen ${ago(Date.now() / 1000 - m.last_seen)}</td><td class="mute">${esc(attrs)}</td></tr>`;
    }
    return `<tr class="row${sel ? ' sel' : ''}" data-machine="${m.id}"><td><span class="live strong">● UP</span></td><td class="strong">${esc(m.name)}</td>
      <td>${segbar([{ frac: m.cpu.prod, cls: 'prod' }, { frac: m.cpu.nonprod, cls: 'nonprod' }], w, { marker: m.cpu.used })} <span class="mute">${num(m.allocated.cpu)}/${num(m.capacity.cpu)}</span></td>
      <td>${segbar([{ frac: m.ram.prod, cls: 'prod' }, { frac: m.ram.nonprod, cls: 'nonprod' }], w, { marker: m.ram.used })} <span class="mute">${Math.round(m.allocated.ram)}/${Math.round(m.capacity.ram)}</span></td>
      <td>${sparkline(hist, 8)} <span class="mute">${m.taskList.length}</span></td><td class="mute">${esc(attrs)}</td></tr>`;
  }).join('');
  patch(p.body, `<table class="tbl"><thead><tr><th>state</th><th>name</th><th>cpu alloc ┃use</th><th>ram MB</th><th>use · tasks</th><th>attributes</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="mute" style="margin-top:.4em"><span class="b-production">█</span> prod <span class="b-batch">█</span> non-prod <span>┃</span> actual use (cgroup)</p>`);
}

function renderDetail(shell, p) {
  const m = shell.selectedMachine();
  if (!m) {
    p.title('machine');
    p.meta('');
    return patch(p.body, `<div class="empty-state"><p class="es-title">No machine selected.</p><p>Pick one on the left. You can then press <kbd>f</kbd> to simulate a failure and watch Borg move its work elsewhere.</p></div>`);
  }
  p.title(m.name);
  p.meta(m.up ? 'f simulates a failure' : 'down: rejoins automatically when it answers again');
  const w = Math.max(10, Math.min(48, cols(p.body) - 30));
  const hist = shell.store.history.machines.get(m.id) || [];
  const tasks = m.taskList.map((t) => {
    const j = shell.model.jobsById.get(t.job);
    return `<tr class="row" data-job="${t.job}"><td class="strong">${esc(fit(`${t.job_name}/${t.index}`, 22))}</td><td>${j ? band(j) : ''}</td><td>${badge(t.state, TASK_BADGE)}</td>
      <td>${num(t.cpu_usage)}/${num(t.cpu)} <span class="mute">cpu</span></td><td>${Math.round(t.mem_mb)}/${t.ram_mb} <span class="mute">MB</span></td></tr>`;
  }).join('');
  patch(p.body, `
    <dl class="kv">
      <dt>status</dt><dd>${m.up ? '<span class="live strong">● UP</span> answering polls every second' : '<span class="err strong">○ DOWN</span> missed 3 polls; the master moved its tasks'}</dd>
      <dt>address</dt><dd>${esc(m.address)}</dd>
      <dt>capacity</dt><dd>${num(m.capacity.cpu)} cpu · ${Math.round(m.capacity.ram)} MB · ${m.cgroups ? '<span class="live">cgroup v2 isolation</span>' : '<span class="warn">no isolation (not running in Docker)</span>'}</dd>
      <dt>attributes</dt><dd>${Object.entries(m.attributes || {}).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(' · ') || '<span class="mute">none</span>'}</dd>
      <dt>packages</dt><dd>${m.packages?.length ? esc(m.packages.join(', ')) : '<span class="mute">none cached (first start of a job installs it)</span>'}</dd>
      <dt>cpu</dt><dd>${segbar([{ frac: m.cpu.prod, cls: 'prod' }, { frac: m.cpu.nonprod, cls: 'nonprod' }], w, { marker: m.cpu.used })} ${num(m.allocated.cpu)}/${num(m.capacity.cpu)} alloc · ${num(m.usage.cpu)} used</dd>
      <dt>ram</dt><dd>${segbar([{ frac: m.ram.prod, cls: 'prod' }, { frac: m.ram.nonprod, cls: 'nonprod' }], w, { marker: m.ram.used })} ${Math.round(m.allocated.ram)}/${Math.round(m.capacity.ram)} MB alloc · ${Math.round(m.usage.ram)} used</dd>
      <dt>cpu use</dt><dd>${sparkline(hist, w)} <span class="mute">last ${hist.length}s</span></dd>
    </dl>
    ${m.taskList.length ? `<table class="tbl" style="margin-top:.6em"><thead><tr><th>task</th><th>priority</th><th>state</th><th>cpu</th><th>memory</th></tr></thead><tbody>${tasks}</tbody></table>`
      : '<p class="mute" style="margin-top:.6em">No tasks on this machine.</p>'}
    <div class="actions">${m.up ? keyBtn('f', 'fail for 20 s', 'fail') : ''}</div>`);
}
