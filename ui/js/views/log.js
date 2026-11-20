// 4 log: every event, newest at the bottom. Kind chips, a text filter ("!" inverts), and
// follow mode like `tail -f`: scrolling up pauses it, End resumes.

import { EVENT_KINDS, eventLine, matcher } from './common.js';
import { esc } from '../lib/format.js';
import { patch } from '../lib/dom.js';

export default {
  id: 'log',
  title: 'log',
  panels: [{ id: 'events', title: 'event log' }],
  ticks: false,

  render(shell, P) {
    const p = P.events;
    const all = shell.store.events;
    const kinds = shell.logKinds;
    const match = matcher(shell.filter.log);
    const list = all.filter((e) => (!kinds.size || kinds.has(e.kind)) && match(e.msg, e.kind));
    const chips = Object.entries(EVENT_KINDS).map(([k, label]) =>
      `<button type="button" class="chip" data-act="kind" data-kind="${k}" aria-pressed="${kinds.has(k)}">${esc(label)}</button>`).join('');
    p.meta(`${list.length}${list.length !== all.length ? `/${all.length}` : ''} events · ${shell.logFollow ? 'following ▾' : 'paused · End to follow'}`);
    if (!p.head) {
      p.head = document.createElement('div');
      p.head.className = 'chips';
      p.head.style.marginBottom = '.4em';
      p.body.before(p.head);
    }
    patch(p.head, `<button type="button" class="chip" data-act="kind" data-kind="" aria-pressed="${!kinds.size}">all</button>${chips}
      ${shell.filter.log ? `<button type="button" class="chip" data-act="clear-filter" aria-pressed="true">filter "${esc(shell.filter.log)}" ✗</button>` : '<button type="button" class="chip" data-act="filter">/ filter…</button>'}`);
    if (!all.length) return patch(p.body, '<p class="mute">Nothing has happened yet. Schedule a job (<kbd>n</kbd>) and every placement, preemption and failure will appear here.</p>');
    if (!list.length) return patch(p.body, `<p class="mute">No events match. <button type="button" class="linkbtn" data-act="clear-filter">Clear the filter</button>.</p>`);
    const q = (shell.filter.log || '').trim();
    patch(p.body, list.slice(-800).map((e) => eventLine(e, q)).join(''));
    if (shell.logFollow) p.body.scrollTop = p.body.scrollHeight;
  },

  list() {
    return null;
  },

  hints() {
    return [['/', 'filter', 'filter'], ['G', 'follow', 'follow']];
  },
};
