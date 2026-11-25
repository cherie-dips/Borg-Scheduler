// LIVE BORG CELL. One screen, four tabs:
//
//   DEMOS    three columns: the list of guided demos, the output of the selected one (printed
//            like a terminal and kept, so earlier steps can be read again), and the live cell
//   CONSOLE  the same screen driven by hand: shortcuts, a borg> prompt, and the live cell
//   CELL     every number: the machines as a table, the jobs, the control plane, the quotas
//   LOG      what the Borgmaster did, newest first
//
// DEMOS and CONSOLE share the cell column: switching between them changes the two columns on
// the left and never rebuilds the cell. A view is built once when it opens; after that only the
// regions whose content changed are redrawn (ui/regions.js), so nothing moves under the pointer
// and task chips can slide.

import { app } from './app.js';
import { clock, esc, num, sentence } from './lib/format.js';
import { DEMOS, demoByKey } from './core/demos.js';
import { BANDS, jobStatus, whyWaiting } from './core/model.js';
import { attributes, machineList, machineState, meter, queueRow } from './ui/cellview.js';
import { konsole } from './ui/console.js';
import { demos } from './ui/democtl.js';
import { $, forget, put, putAnimated } from './ui/regions.js';
import { atLatest, showLatest, transcriptHtml } from './ui/transcript.js';

const { store } = app;

// The guided demos, in the order they are listed, and the section of the paper each one shows.
const GROUPS = [
  { title: 'Scheduling', keys: ['tour', 'fair', 'quota', 'reclaim'] },
  { title: 'Jobs and allocs', keys: ['after', 'overrides', 'update', 'allocs'] },
  { title: 'Names and health checks', keys: ['names', 'health'] },
  { title: 'Failures and maintenance', keys: ['crash', 'drain', 'failover'] },
];
const PAPER = { tour: '§3.2', fair: '§3.2', quota: '§2.5', reclaim: '§5.5', after: '§2.3', overrides: '§2.3', update: '§2.3', allocs: '§2.4', names: '§2.6', health: '§2.6', crash: '§4', drain: '§4', failover: '§3.1' };
{
  const listed = new Set(GROUPS.flatMap((g) => g.keys));
  for (const d of DEMOS) if (!listed.has(d.key)) GROUPS[GROUPS.length - 1].keys.push(d.key);
}

const seenReplicas = new Set();
let cleaning = false;
let selected = GROUPS[0].keys[0]; // the demo whose output is on screen
let view = { name: '' };          // {name: demos | console | cell | log}
let notice = null;                // {text, until}: shown in the status line for a few seconds

function say(text, ms = 6000) {
  notice = { text, until: Date.now() + ms };
  app.render();
  setTimeout(() => app.render(), ms + 50);
}

// Why a demo cannot run on this cell right now ('' when it can).
function unavailable(d) {
  if (d.key !== 'failover') return '';
  const reps = store.state?.master?.replicas || [];
  if (reps.length < 2) return 'This demo needs the cell with Borgmaster replicas: tools/cell.sh start ha';
  // The page has to keep working when the elected master dies, so it must come from another one.
  if (store.replica?.elected) {
    const other = reps.find((r) => !r.elected);
    const url = other ? other.url.replace('127.0.0.1', location.hostname || 'localhost') : '';
    return `This page comes from the elected master, which the demo kills. Open it from another replica${url ? `: ${url}` : ''}`;
  }
  return '';
}

// How the cell is drawn right now: what to dim and what to point at.
function cellCtx() {
  const v = view.name === 'demos' ? demos.runs[selected] : null;
  const live = v?.status === 'running';
  return {
    prefix: demos.prefix,
    dimOthers: !!v && (live || (v === demos.view && demos.leftovers() > 0)), // a demo's jobs stand out while they are there
    focusJob: live && v.focus?.kind === 'job' ? v.focus.id : null,
    focusMachine: live && v.focus?.kind === 'machine' ? v.focus.id : null,
    reclaim: !!store.state?.reclamation?.enabled,
    now: store.state?.time,
  };
}

// ---- header and status line ----------------------------------------------------------------------

const LINK = {
  connecting: ['', 'CONNECTING'],
  live: ['ok', 'LIVE'],
  electing: ['warn', 'ELECTING A NEW BORGMASTER'],
  down: ['bad', 'NOT CONNECTED'],
};
const POLICY = { hybrid: 'hybrid', best_fit: 'best fit', worst_fit: 'worst fit' };
const LEGEND = `<span class="legend"><span><i class="prod"></i>PRODUCTION</span><span><i class="batch"></i>BATCH</span><span><i class="free"></i>FREE</span><span><i class="mon"></i>MONITORING</span><span><i class="wait"></i>WAITING</span></span>`;

// The replicas as squares: the elected one filled, one that does not answer crossed out.
function replicaMarks(ms) {
  const live = ms.replicas || [];
  for (const r of live) seenReplicas.add(r.name);
  const up = new Set(live.map((r) => r.name));
  const names = [...seenReplicas].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return names.map((n) => `<i class="rep${n === ms.name ? ' leader' : up.has(n) ? '' : ' gone'}" title="${esc(n)}${n === ms.name ? ': elected' : up.has(n) ? ': following' : ': not answering'}"></i>`).join('');
}

function drawChrome() {
  const [tone, word] = LINK[store.link] || LINK.connecting;
  const m = store.model;
  put('status', `<span class="state ${tone}"><i class="dot"></i>${word}</span>${m
    ? `<span>${m.machinesUp}/${m.machines.length} MACHINES UP</span><span>${m.running} TASKS RUNNING</span><span>${m.waiting} WAITING</span>` : ''}`);

  for (const a of document.querySelectorAll('.tabs a')) {
    const on = a.dataset.tab === view.name;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
    if (a.dataset.tab === 'demos') a.classList.toggle('running', !!demos.running);
  }

  // The status line: a problem with the connection, else what just happened, else the control plane.
  let left;
  if (store.link === 'electing') left = '<span class="msg warn">The Borgmaster replicas are electing a new master. The machines keep running their tasks.</span>';
  else if (store.link === 'down') left = '<span class="msg bad">The Borgmaster does not answer. Is the cell running? Start it with tools/cell.sh start.</span>';
  else if (notice && notice.until > Date.now()) left = `<span class="msg">${esc(notice.text)}</span>`;
  else if (m) {
    const s = m.raw, ms = s.master || {};
    const master = (ms.replicas || []).length
      ? `<span><b>BORGMASTER</b>${esc(ms.name)} elected<span class="reps">${replicaMarks(ms)}</span></span>`
      : '<span><b>BORGMASTER</b>one copy</span>';
    left = `${master}<span><b>SCHEDULER</b>${ms.scheduler?.separate ? 'separate process' : 'inside the Borgmaster'}</span>
      <span><b>SCORING</b>${esc(POLICY[s.policy] || s.policy || '')}</span><span><b>RECLAMATION</b>${s.reclamation?.enabled ? 'on' : 'off'}</span>`;
  } else left = '<span>Waiting for the Borgmaster…</span>';
  put('foot', `<div class="foot-l">${left}</div>${LEGEND}`);
}

// ---- DEMOS: the list and the output -----------------------------------------------------------------

function listRow(k) {
  const d = demoByKey(k);
  const v = demos.runs[k];
  const st = v?.status || '';
  const off = !!unavailable(d) && st !== 'running';
  const mark = st === 'running' ? `<span class="dl-m run">${Math.max(1, v.stage)}/${d.steps.length}</span>`
    : st === 'ok' ? '<span class="dl-m ok">✓</span>'
      : st === 'failed' ? '<span class="dl-m bad">✗</span>'
        : st === 'stopped' ? '<span class="dl-m warn">■</span>' : '';
  return `<a class="dl${k === selected ? ' on' : ''}${off ? ' off' : ''}" href="#/demos/${k}" data-demo="${k}" title="${esc(sentence(d.blurb))}"${k === selected ? ' aria-current="true"' : ''}>
    <span class="dl-t">${esc(d.title)}</span>${mark}</a>`;
}

let shownRun = null; // "<demo>:<start time>" of the output on screen

// "LATEST" appears when the newest line is scrolled out of view: while the demo runs, and after
// it until its result has been seen once.
function syncJump() {
  const jump = $('d-jump'), box = $('d-out');
  if (!jump || !box) return;
  const v = demos.runs[selected];
  const at = !v || atLatest(box);
  if (v && at && v.status !== 'running') v.seenEnd = true;
  jump.hidden = at || (v.status !== 'running' && !!v.seenEnd);
}

const demoPanes = {
  mount() {
    return `<section class="pane" id="p-left"><h2>DEMOS</h2>
        <nav class="pane-b" id="d-list" aria-label="Guided demos"></nav>
        <div class="pane-f" id="d-actions"></div>
      </section>
      <section class="pane" id="p-mid"><h2>OUTPUT</h2><span class="pane-r" id="elapsed"></span>
        <div class="pane-b" id="d-out"></div>
        <button type="button" class="jump" id="d-jump" data-act="jump" hidden>▼ LATEST</button>
      </section>`;
  },
  mounted() {
    shownRun = null; // nothing drawn yet: the first draw shows the newest line
    $('d-out').addEventListener('scroll', syncJump, { passive: true });
  },
  update() {
    const d = demoByKey(selected);
    const v = demos.runs[selected] || null;
    const running = demos.running;
    const why = unavailable(d);

    put('d-list', GROUPS.map((g) => `<h3>${esc(g.title.toUpperCase())}</h3>${g.keys.map(listRow).join('')}`).join(''));

    // RUN, STOP and CLEAN UP are always there, so nothing shifts when a demo starts or ends.
    const canRun = !running && !why && !!store.model;
    const left = demos.leftovers();
    put('d-actions', `<div class="row">
        <button type="button" class="btn primary" data-act="run" data-demo="${selected}"${canRun ? '' : ' disabled'}>${v && !running ? 'RUN AGAIN' : 'RUN'}</button>
        <button type="button" class="btn stop" data-act="stop"${running && !v?.stopping ? '' : ' disabled'}>${v?.stopping ? 'STOPPING…' : 'STOP'}</button>
      </div>
      <button type="button" class="btn wide" data-act="clean" title="Removes the jobs the demos left in the cell"${left && !running && !cleaning ? '' : ' disabled'}>${cleaning ? 'CLEANING UP…' : left ? `CLEAN UP ${left} DEMO JOB${left === 1 ? '' : 'S'}` : 'CLEAN UP'}</button>`);

    const note = why || (running && running !== selected ? `Another demo is running (${demoByKey(running)?.title || running}). One runs at a time.` : '');
    // Keep the newest line in view, unless someone scrolled up to read an earlier step.
    const box = $('d-out');
    const run = `${selected}:${v?.started || 0}`;
    const stick = shownRun !== run || atLatest(box); // another demo or run came on screen, or its newest line is in view
    // Only the latest run can still have jobs in the cell: starting a demo clears the one before.
    const leftovers = v && v === demos.view && !v.cleaned ? left : 0;
    if (put('d-out', transcriptHtml(d, v, { paper: PAPER[selected], note, leftovers })) && stick) showLatest(box);
    shownRun = run;
    syncJump();
  },
};

// ---- DEMOS and CONSOLE: two columns that change, and the cell that stays -----------------------------

const SIDES = { demos: demoPanes, console: konsole };

function openSide() {
  forget(['status', 'foot', 'w-cell']); // the cell on the right stays as it is
  $('w-side').innerHTML = SIDES[view.name].mount();
  SIDES[view.name].mounted?.();
}

const workPage = {
  mount() {
    return `<div class="work">
      <div class="work-side" id="w-side"></div>
      <section class="pane" id="p-cell"><h2>CELL</h2><div class="pane-b" id="w-cell"></div></section>
    </div>`;
  },
  mounted: openSide,
  update() {
    SIDES[view.name].update();
    const model = store.model;
    if (!model) return put('w-cell', '<p class="none">Connecting to the Borgmaster…</p>');
    const ctx = cellCtx();
    putAnimated('w-cell', `${queueRow(model, ctx)}${machineList(model, ctx)}`);
  },
};

// ---- CELL: every number ------------------------------------------------------------------------------

function machinesTable(model, ctx) {
  const reclaim = ctx.reclaim;
  const rows = model.machines.map((m) => {
    const r = m.reserved || m.allocated || {};
    return `<tr class="${m.state}"><th scope="row">${esc(m.name)}</th><td>${machineState(m)}</td>
      <td class="wide">${meter('', m, 'cpu', ctx)}</td><td class="wide">${meter('', m, 'ram', ctx)}</td>
      <td>${num(m.usage?.cpu || 0)} CPU · ${Math.round(m.usage?.ram || 0)} MB</td>
      ${reclaim ? `<td>${num(r.cpu ?? m.cpu.asked)} CPU · ${Math.round(r.ram ?? m.ram.asked)} MB</td>` : ''}
      <td>${m.ports ? `${m.ports.used}/${m.ports.hi - m.ports.lo + 1}` : '—'}</td><td>${m.count}</td><td>${esc(attributes(m) || '—')}</td></tr>`;
  }).join('');
  return `<table class="tbl"><thead><tr><th>MACHINE</th><th>STATE</th><th>CPU ASKED / CAPACITY</th><th>MEMORY ASKED / CAPACITY</th><th>IN USE</th>${reclaim ? '<th>RESERVED</th>' : ''}<th>PORTS</th><th>TASKS</th><th>ATTRIBUTES</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function jobsTable(s) {
  const jobs = [...(s.jobs || [])].sort((a, b) => Number(a.done) - Number(b.done) || b.id - a.id);
  if (!jobs.length) return '<p class="none">No jobs. Run a demo, or start one on the CONSOLE tab.</p>';
  const why = new Map(); // job id -> why its first waiting task has no machine
  for (const t of s.tasks || []) if (t.state === 'pending' && t.reason && !why.has(t.job)) why.set(t.job, t.reason);
  const rows = jobs.map((j) => `<tr><th scope="row">${esc(j.name)}</th><td>${esc(j.user)}</td>
    <td><span class="band ${BANDS[j.band]?.cls || 'free'}"><i></i>${esc((BANDS[j.band]?.label || j.band).toUpperCase())}</span></td><td>${j.priority}</td><td>${j.type === 'alloc' ? `${j.tasks} allocs` : j.tasks}</td>
    <td>${esc(jobStatus(j))}${why.has(j.id) && !j.done ? `: ${esc(whyWaiting(why.get(j.id)))}` : ''}</td></tr>`).join('');
  return `<table class="tbl"><thead><tr><th>JOB</th><th>USER</th><th>BAND</th><th>PRIORITY</th><th>TASKS</th><th>STATE</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// The control plane as rows of [label, value].
function factsHtml(s) {
  const ms = s.master || {}, sc = ms.scheduler || {}, cp = ms.checkpoint || {}, last = s.scheduler || {};
  const live = ms.replicas || [];
  const marks = live.length ? replicaMarks(ms) : '';
  const rows = [
    ['BORGMASTER', live.length ? `${esc(ms.name)} is elected<span class="reps">${marks}</span><br>${live.length} of ${seenReplicas.size} replicas answer · election ${ms.election}` : 'one copy, no replicas'],
    ['CELL STATE', cp.enabled ? `saved to disk after every change<br>${num(cp.seq, 0)} changes so far` : 'in memory only: lost when the Borgmaster stops'],
    ['SCHEDULER', sc.separate ? `a separate process<br>${num(sc.accepted, 0)} placements accepted, ${num(sc.rejected, 0)} sent back` : 'inside the Borgmaster'],
    ['SCORING', `${esc(POLICY[s.policy] || s.policy || '')}: how a machine is picked`],
    ['LAST PASS', last.time ? `${last.placed ?? 0} placed${last.preempted ? `, ${last.preempted} preempted` : ''} in ${num(last.elapsed_ms, 2)} ms` : 'nothing to place yet'],
    ['RECLAMATION', s.reclamation?.enabled ? 'on: unused room is offered to batch work' : 'off: tasks keep all they asked for'],
  ];
  return `<dl class="facts">${rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('')}</dl>`;
}

function quotasHtml() {
  if (!app.quotas.length) return '<p class="none">None set: every user may ask for anything.</p>';
  const rows = app.quotas.map((q) => `<tr><th scope="row">${esc(q.user === '*' ? 'everyone else' : q.user)}</th>
    <td><span class="band ${BANDS[q.band]?.cls || 'free'}"><i></i>${esc((BANDS[q.band]?.label || q.band).toUpperCase())}</span></td>
    <td>${num(q.used?.cpu || 0)}</td><td>${q.cpu == null ? 'none' : num(q.cpu)}</td></tr>`).join('');
  return `<table class="tbl"><thead><tr><th>USER</th><th>BAND</th><th>CPU USED</th><th>LIMIT</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const cellPage = {
  mount() {
    return `<div class="board">
      <section class="pane" id="b-machines"><h2>MACHINES</h2><div class="pane-b" id="c-machines"></div></section>
      <section class="pane" id="b-jobs"><h2>JOBS</h2><div class="pane-b" id="c-jobs"></div></section>
      <section class="pane" id="b-cp"><h2>CONTROL PLANE</h2><div class="pane-b" id="c-facts"></div></section>
      <section class="pane" id="b-quotas"><h2>QUOTAS</h2><div class="pane-b" id="c-quotas"></div></section>
    </div>`;
  },
  update() {
    const model = store.model;
    if (!model) return put('c-machines', '<p class="none">Connecting to the Borgmaster…</p>');
    put('c-machines', machinesTable(model, cellCtx()));
    put('c-jobs', jobsTable(model.raw));
    put('c-facts', factsHtml(model.raw));
    put('c-quotas', quotasHtml());
    app.refreshQuotas(2500);
  },
};

// ---- LOG ---------------------------------------------------------------------------------------------

// event kind -> [label, filter group, colour]
const KIND = {
  schedule: ['PLACED', 'PLACED', 'ok'],
  preempt: ['PREEMPTED', 'PREEMPTED', 'bad'],
  evict: ['EVICTED', 'PREEMPTED', 'bad'],
  task: ['TASK', 'TASKS', ''],
  oom: ['OUT OF MEMORY', 'TASKS', 'bad'],
  exec: ['COMMAND', 'TASKS', ''],
  job: ['JOB', 'JOBS', ''],
  update: ['UPDATE', 'JOBS', ''],
  admission: ['REFUSED', 'JOBS', 'warn'],
  quota: ['QUOTA', 'JOBS', ''],
  machine: ['MACHINE', 'MACHINES', 'warn'],
  drain: ['MAINTENANCE', 'MACHINES', 'warn'],
  health: ['HEALTH CHECK', 'HEALTH', 'warn'],
  poke: ['DEMO', 'HEALTH', ''],
  master: ['BORGMASTER', 'BORGMASTER', ''],
  scheduler: ['SCHEDULER', 'BORGMASTER', ''],
  config: ['SETTINGS', 'BORGMASTER', ''],
  reclaim: ['RECLAMATION', 'BORGMASTER', ''],
  error: ['ERROR', 'BORGMASTER', 'bad'],
};
const FILTERS = ['ALL', 'PLACED', 'PREEMPTED', 'TASKS', 'JOBS', 'MACHINES', 'HEALTH', 'BORGMASTER'];
const log = { filter: 'ALL', query: '', seen: 0 };
const feed = { items: [], seq: 0, busy: false };

const logPage = {
  mount() {
    return `<section class="pane full"><h2>EVENT LOG</h2><span class="pane-r">NEWEST FIRST</span>
      <div class="filters">${FILTERS.map((f) => `<button type="button" class="${f === log.filter ? 'on' : ''}" data-act="filter" data-f="${f}" aria-pressed="${f === log.filter}">${f}</button>`).join('')}
        <label class="find">FIND<input id="a-q" type="search" autocomplete="off" spellcheck="false"></label></div>
      <div class="pane-b" id="a-rows"></div>
    </section>`;
  },
  mounted() {
    const q = $('a-q');
    q.value = log.query;
    q.addEventListener('input', () => {
      log.query = q.value;
      logPage.update();
    });
    // Lines that arrive while the tab is open are marked; the ones already there are not.
    log.seen = feed.items.length ? feed.items[feed.items.length - 1].seq : 0;
  },
  update() {
    const q = log.query.trim().toLowerCase();
    const rows = [];
    for (let i = feed.items.length - 1; i >= 0 && rows.length < 300; i--) {
      const e = feed.items[i];
      const group = (KIND[e.kind] || [e.kind, 'BORGMASTER'])[1];
      if ((log.filter === 'ALL' || group === log.filter) && (!q || String(e.msg).toLowerCase().includes(q))) rows.push(e);
    }
    put('a-rows', rows.length
      ? rows.map((e) => {
        const [label, , tone] = KIND[e.kind] || [String(e.kind).toUpperCase(), '', ''];
        return `<p class="ev${e.seq > log.seen ? ' new' : ''}"><time>${clock(e.time)}</time><span class="ev-k ${tone}">${esc(label)}</span><span>${esc(String(e.msg).replace(/ -> /g, ' → '))}</span></p>`;
      }).join('')
      : `<p class="none">${feed.items.length ? 'Nothing matches.' : 'Nothing has happened yet.'}</p>`);
  },
};

// The event log is read in the background, whatever tab is open.
async function pollEvents() {
  if (feed.busy) return;
  feed.busy = true;
  try {
    const r = await store.api.events(feed.seq);
    if ((r.last ?? 0) < feed.seq) feed.items = []; // a Borgmaster with a shorter log took over
    feed.seq = r.last ?? feed.seq;
    if (r.events?.length) {
      feed.items = feed.items.concat(r.events).slice(-500);
      if (view.name === 'log') logPage.update();
    }
  } catch {
    /* the header shows the connection state */
  } finally {
    feed.busy = false;
  }
}

// ---- routing and drawing ---------------------------------------------------------------------------

function route() {
  const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
  if (a === 'console' || a === 'cell' || a === 'log') return { name: a };
  if (b && demoByKey(b)) selected = demoByKey(b).key;
  return { name: 'demos' };
}

const PAGES = { demos: workPage, console: workPage, cell: cellPage, log: logPage };

function mount() {
  const next = route();
  const from = view.name;
  view = next;
  if (from === view.name) {
    /* another demo was selected: nothing is rebuilt */
  } else if (PAGES[from] === workPage && PAGES[view.name] === workPage) {
    openSide(); // DEMOS <-> CONSOLE: the cell keeps drawing
  } else {
    forget(['status', 'foot']);
    $('view').innerHTML = PAGES[view.name].mount();
    PAGES[view.name].mounted?.();
  }
  draw();
}

function draw() {
  drawChrome();
  PAGES[view.name].update();
  tick();
}

// The demo's clock changes every second; it is set directly so nothing else is redrawn for it.
function tick() {
  const el = $('elapsed');
  if (!el || view.name !== 'demos') return;
  const v = demos.runs[selected];
  if (!v) {
    el.textContent = '';
    return;
  }
  const secs = Math.max(0, Math.round(((v.ended || Date.now()) - v.started) / 1000));
  el.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

// ---- actions ---------------------------------------------------------------------------------------

async function clean() {
  if (cleaning) return;
  cleaning = true;
  app.render();
  try {
    say(await demos.clean());
  } catch (e) {
    say(sentence(e.message));
  } finally {
    cleaning = false;
    await store.refresh();
    app.render();
  }
}

async function copy(el) {
  try {
    await navigator.clipboard.writeText(el.dataset.cmd);
    say('Copied. Paste it into a terminal in the project folder.');
  } catch {
    say(`Copy it by hand: ${el.dataset.cmd}`, 15000);
  }
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  if (act === 'run') demos.run(el.dataset.demo);
  else if (act === 'stop') demos.stop();
  else if (act === 'clean') clean();
  else if (act === 'jump') showLatest($('d-out'));
  else if (act === 'copy') copy(el);
  else if (act === 'filter') {
    log.filter = el.dataset.f;
    for (const b of document.querySelectorAll('.filters button')) {
      b.classList.toggle('on', b.dataset.f === log.filter);
      b.setAttribute('aria-pressed', String(b.dataset.f === log.filter));
    }
    logPage.update();
  } else konsole.act(act, el);
  app.render();
});

store.on((kind, data) => {
  if (kind === 'master') say(`${data.name} is now the elected Borgmaster (election ${data.election}).`, 9000);
  app.render();
});

window.addEventListener('hashchange', mount);
app.draw = draw;
window.miniBorg = { demos, store }; // for the browser test

mount();
store.start(1000);
setInterval(tick, 1000);
setInterval(pollEvents, 1000);
pollEvents();
