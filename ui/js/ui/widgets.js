// HTML snippets shared by the views: status badges, band labels, text bars, sparklines.
// They return strings; colours come from CSS classes so themes apply everywhere.

import { bar, clamp, dur, esc, segments, spark, spinner } from '../lib/format.js';

export const BADGE = {
  running: ['▶', 'RUN', 'live'],
  queued: ['◌', 'QUEUE', 'warn'],
  waiting: ['◔', 'WAIT', 'info'],
  completed: ['✓', 'DONE', 'done'],
  failed: ['✗', 'FAIL', 'err'],
  killed: ['⊘', 'KILL', 'mute'],
};

export const TASK_BADGE = {
  running: ['▶', 'RUN', 'live'],
  installing: ['▸', 'INST', 'info'],
  starting: ['▸', 'START', 'info'],
  pending: ['◌', 'QUEUE', 'warn'],
  waiting: ['◔', 'WAIT', 'info'],
  finished: ['✓', 'DONE', 'done'],
  failed: ['✗', 'FAIL', 'err'],
  oom: ['✗', 'OOM', 'err'],
  killed: ['⊘', 'KILL', 'mute'],
};

// Fixed-width status tag: glyph + word + colour (never colour alone). With a spinner frame,
// the glyph animates (only used while a job waits for room).
export function badge(status, table = BADGE, frame = null) {
  const [g, word, cls] = table[status] || ['?', status.toUpperCase(), 'mute'];
  const glyph = frame != null ? `<span class="spin">${spinner(frame)}</span>` : g;
  return `<span class="badge ${cls}">${glyph} ${word.padEnd(5)}</span>`;
}

export const BAND_SHORT = { monitoring: 'mon', production: 'prod', batch: 'batch', free: 'free' };

export function band(job) {
  return `<span class="band b-${job.band}">${BAND_SHORT[job.band] || job.band} ${String(job.priority).padStart(3)}</span>`;
}

// Multi-colour text bar: parts are [{frac, cls}] of the whole width.
export function segbar(parts, width, { marker = null, empty = '░' } = {}) {
  const { parts: segs, rest } = segments(parts, width);
  let cells = [];
  for (const s of segs) for (let i = 0; i < s.cells; i++) cells.push(s.cls);
  for (let i = 0; i < rest; i++) cells.push(null);
  let markAt = -1;
  if (marker != null) markAt = clamp(Math.round(marker * width) - 1, 0, width - 1);
  let html = '', run = '', cur;
  const flush = () => {
    if (run) html += cur ? `<span class="${cur}">${run}</span>` : `<span class="empty${empty === '·' ? ' dots' : ''}">${run}</span>`;
    run = '';
  };
  cells.forEach((cls, i) => {
    const isMark = i === markAt;
    const key = isMark ? 'mark' : cls;
    if (key !== cur) {
      flush();
      cur = key;
    }
    run += isMark ? '┃' : cls ? '█' : empty;
  });
  flush();
  return `<span class="tbar" aria-hidden="true">${html}</span>`;
}

export function simpleBar(frac, width, cls = 'fill') {
  return `<span class="tbar" aria-hidden="true"><span class="${cls}">${bar(frac, width, '')}</span><span class="empty">${'░'.repeat(Math.max(0, width - [...bar(frac, width, '')].length))}</span></span>`;
}

export function sparkline(values, width, cls = 'spark') {
  return `<span class="${cls}" aria-hidden="true">${esc(spark(values, width, 1))}</span>`;
}

// Progress cell for a job: bar + words, per status.
export function jobProgress(j, width) {
  const w = Math.max(6, width);
  switch (j.status) {
    case 'waiting':
      return `${segbar([], w, { empty: '·' })} <span class="info">starts in ${dur(j.startsIn)}</span>`;
    case 'queued':
      return `${segbar([{ frac: j.doneFrac, cls: 'fill done' }], w)} <span class="warn">${esc(shortReason(j.reason))}</span>`;
    case 'running':
      if (j.progress == null) {
        return `${segbar([{ frac: j.up / j.n, cls: 'fill live' }], w)} <span>${j.up}/${j.n} up</span><span class="mute"> · ${j.up && j.uptime != null ? dur(j.uptime) : 'starting…'}</span>`;
      }
      return `${segbar([{ frac: j.doneFrac, cls: 'fill done' }, { frac: j.failedFrac, cls: 'fill err' }, { frac: j.runFrac, cls: 'fill live' }], w)} <span>${Math.floor(j.progress * 100)}%</span><span class="mute"> · ${j.eta != null ? `eta ${dur(j.eta)}` : `${j.c.running}/${j.n} running`}</span>`;
    case 'completed':
      return `${segbar([{ frac: 1, cls: 'fill done' }], w)} <span class="mute">${j.n}/${j.n} · ${dur(j.elapsed)}</span>`;
    case 'killed':
      return `${segbar([{ frac: j.doneFrac, cls: 'fill done' }], w, { empty: '·' })} <span class="mute">stopped</span>`;
    case 'failed':
      return `${segbar([{ frac: j.doneFrac, cls: 'fill done' }, { frac: j.failedFrac, cls: 'fill err' }], w)} <span class="err">${esc(shortReason(j.reason))}</span>`;
    default:
      return '';
  }
}

export function shortReason(r) {
  if (!r) return '';
  return r
    .replace(/^waiting: /, '')
    .replace('no machine has enough free resources at this priority', 'no room at this priority')
    .replace('no machine satisfies the constraints / size', 'no machine fits')
    .replace(/^OOM-killed: exceeded memory limit of (\d+) MB$/, 'OOM: over $1 MB');
}

export function emptyState(title, lines, actions = '') {
  return `<div class="empty-state"><p class="es-title">${title}</p>${lines.map((l) => `<p>${l}</p>`).join('')}${actions ? `<div class="es-actions">${actions}</div>` : ''}</div>`;
}

// A clickable key hint: <button data-act="new"><kbd>n</kbd> new job</button>
export const keyBtn = (key, label, act, extra = '') =>
  `<button type="button" class="kbtn" data-act="${act}" ${extra}><kbd>${esc(key)}</kbd>${label ? ` ${esc(label)}` : ''}</button>`;
