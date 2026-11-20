// Pieces shared by several views: job rows, machine rows, events, filtering.

import { badge, band, jobProgress, segbar, sparkline } from '../ui/widgets.js';
import { ago, clock, esc, fit, num } from '../lib/format.js';

// Text filter with "!" to invert; matches any of the given fields.
export function matcher(filter) {
  const f = (filter || '').trim().toLowerCase();
  if (!f) return () => true;
  const inv = f.startsWith('!');
  const q = inv ? f.slice(1).trim() : f;
  if (!q) return () => true;
  return (...fields) => fields.join(' ').toLowerCase().includes(q) !== inv;
}

export const jobMatches = (filter) => {
  const m = matcher(filter);
  return (j) => m(j.name, j.user, j.band, j.status, j.type, j.group, `prio ${j.priority}`);
};

export function jobRow(j, { sel, nameW, barW, frame }) {
  return `<tr class="row${sel ? ' sel' : ''}" data-job="${j.id}" aria-selected="${sel}">
    <td>${badge(j.status, undefined, j.status === 'queued' ? frame : null)}</td>
    <td class="strong">${esc(fit(j.name, nameW))}</td>
    <td>${band(j)}</td>
    <td>${jobProgress(j, barW)}</td></tr>`;
}

export function machineLine(m, { sel, hist, barW }) {
  const name = esc(fit(m.name, 11));
  if (!m.up) {
    return `<div class="lrow${sel ? ' sel' : ''}" data-machine="${m.id}"><span class="err">○</span> ${name} <span class="err strong">DOWN</span> <span class="mute">· tasks moved elsewhere · last seen ${ago(Date.now() / 1000 - m.last_seen)}</span></div>`;
  }
  const cpu = segbar([{ frac: m.cpu.prod, cls: 'prod' }, { frac: m.cpu.nonprod, cls: 'nonprod' }], barW, { marker: m.cpu.used });
  return `<div class="lrow${sel ? ' sel' : ''}" data-machine="${m.id}"><span class="live">●</span> ${name} ${cpu} <span class="mute">${num(m.allocated.cpu)}/${num(m.capacity.cpu)}</span> ${sparkline(hist || [], 8)}</div>`;
}

// Event classification for colours, glyphs and the "bad" rule.
export function eventStyle(e) {
  const bad = e.kind === 'oom' || e.kind === 'error' || / DOWN|failed|lost on /.test(e.msg);
  const glyph = { schedule: '→', preempt: '↓', task: '▸', job: '◈', machine: '■', config: '≡', oom: '✗', error: '✗' }[e.kind] || '·';
  return { bad, glyph: bad ? '✗' : glyph };
}

export function eventLine(e, q = '') {
  const { bad, glyph } = eventStyle(e);
  let msg = esc(e.msg);
  if (q && !q.startsWith('!')) {
    const i = e.msg.toLowerCase().indexOf(q.toLowerCase());
    if (i >= 0) msg = `${esc(e.msg.slice(0, i))}<mark>${esc(e.msg.slice(i, i + q.length))}</mark>${esc(e.msg.slice(i + q.length))}`;
  }
  return `<div class="ev k-${esc(e.kind)}${bad ? ' bad' : ''}"><span class="t">${clock(e.time)}</span><span class="g">${glyph}</span><span class="m">${msg}</span></div>`;
}

export const EVENT_KINDS = {
  job: 'jobs', schedule: 'placements', preempt: 'preemptions', task: 'tasks', oom: 'out of memory', machine: 'machines', config: 'config', error: 'errors',
};
