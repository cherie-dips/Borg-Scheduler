// The console: the cell driven by hand. A prompt (borg>) takes typed commands (core/commands.js);
// the shortcuts in the left column type a ready-made command at the prompt and run it, so the
// audience sees the command either way. What was typed and printed stays on screen.

import { app } from '../app.js';
import { COMMANDS, RUN_OPTIONS, findMachine, freeName, parse } from '../core/commands.js';
import { fitCount } from '../core/demos.js';
import { BANDS, PLACED, jobStatus, whyWaiting } from '../core/model.js';
import { clamp, esc, num, plural, sentence } from '../lib/format.js';
import { demos } from './democtl.js';
import { $, put } from './regions.js';

const { api, store } = app;

const POLICY = {
  hybrid: ['hybrid', 'it packs tasks tightly and keeps free CPU and memory in balance on each machine'],
  best_fit: ['best fit', 'each task goes to the fullest machine it fits on'],
  worst_fit: ['worst fit', 'each task goes to the emptiest machine'],
};
const SHORT_BAND = { production: 'prod', batch: 'batch', free: 'free', monitoring: 'mon' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lines = [];   // what is on screen: {cls, text}. cls: cmd | ok | err | warn | out | pre
let shown = 0;      // how many of them are in the page
const history = []; // the commands typed, oldest first
let at = -1;        // where ↑ and ↓ are in that history (-1: not browsing)
let busy = false;   // a command is running
let typed = '';     // what is at the prompt; kept when the tab is left

// ---- printing --------------------------------------------------------------------------------------

const MARK = { ok: '✓', err: '✗', warn: '…' };

function lineHtml({ cls, text }) {
  if (cls === 'cmd') return `<p class="ln cmd"><b>borg&gt;</b> ${esc(text)}</p>`;
  const mark = MARK[cls] ? `<span class="mk">${MARK[cls]}</span>` : '';
  return `<p class="ln ${cls}">${mark}${esc(text)}</p>`;
}

// Adds the lines that are not in the page yet, and keeps the prompt in view.
function flush() {
  const out = $('k-out');
  if (!out) return;
  if (shown > lines.length) {
    out.innerHTML = '';
    shown = 0;
  }
  if (shown < lines.length) {
    out.insertAdjacentHTML('beforeend', lines.slice(shown).map(lineHtml).join(''));
    shown = lines.length;
  }
  const term = $('k-term');
  term.scrollTop = term.scrollHeight;
}

function print(cls, text) {
  lines.push({ cls, text });
  if (lines.length > 400) {
    lines.splice(0, lines.length - 400);
    shown = lines.length + 1; // draw again from the start
  }
  flush();
}

// Rows of cells as one aligned block: every column as wide as its widest cell.
function table(rows) {
  const width = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? String(cell) : String(cell).padEnd(width[c] + 2))).join('')).join('\n');
}

// The Borgmaster's words, tidied: "0.50 cpu" -> "0.5 CPU". The first word is left alone,
// because it is often a job's name.
function tidy(msg) {
  const t = String(msg || '').trim().replace(/\bcpu\b/g, 'CPU').replace(/\b\d+\.\d+\b/g, (m) => num(Number(m)));
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

// ---- the commands ---------------------------------------------------------------------------------

const jobsNow = () => store.state?.jobs || [];
const tasksOn = (m) => (store.state?.tasks || []).filter((t) => t.machine === m.id && t.type !== 'alloc' && PLACED.has(t.state)).length;

function machine(word) {
  const all = store.state?.machines || [];
  const m = findMachine(word, all);
  if (!m) throw new Error(`there is no machine "${word}". The machines are: ${all.map((x) => x.name).join(', ')}`);
  return m;
}

// After a job is accepted: waits until its tasks have a machine, or until it is clear why not.
async function follow(name) {
  const t0 = Date.now();
  let reasonSince = 0;
  for (;;) {
    await sleep(500);
    await store.refresh();
    const tasks = (store.state?.tasks || []).filter((t) => t.job_name === name);
    const placed = tasks.filter((t) => PLACED.has(t.state));
    const age = Date.now() - t0;
    if (tasks.length && placed.length === tasks.length) {
      const on = [...new Set(placed.map((t) => t.machine_name))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return print('ok', `${name}: ${tasks.length === 1 ? 'placed' : `all ${tasks.length} tasks placed`} on ${on.length > 4 ? `${on.length} machines` : on.join(', ')}`);
    }
    const why = tasks.find((t) => t.state === 'pending' && t.reason)?.reason;
    reasonSince = why ? reasonSince || Date.now() : 0;
    if ((why && Date.now() - reasonSince > 1500 && age > 2500) || age > 7000) {
      const waiting = tasks.length - placed.length;
      return print('warn', `${name}: ${placed.length} of ${tasks.length} placed, ${waiting} waiting in the queue${why ? `: ${whyWaiting(why)}` : ''}`);
    }
  }
}

const RUN = {
  async run({ spec }) {
    const batch = spec.secs != null;
    try {
      await api.submit({
        name: spec.name, user: spec.user, type: batch ? 'batch' : 'service', priority: spec.priority,
        tasks: spec.tasks, cpu: spec.cpu, ram_mb: spec.mem, distinct: spec.spread,
        workload: batch ? { type: 'sleep', duration: spec.secs } : { type: 'service' },
      });
    } catch (e) {
      // Admission control: the job would take its user over quota (§2.5).
      if (/admission control/i.test(e.message || '')) return print('err', `refused: over quota. ${tidy(e.message.replace(/^rejected by admission control:\s*/i, ''))}`);
      throw e;
    }
    print('ok', `${spec.name} accepted: ${plural(spec.tasks, 'task')} of ${num(spec.cpu)} CPU and ${spec.mem} MB, ${BANDS[spec.band].label.toLowerCase()} priority, user ${spec.user}${batch ? `, runs ${spec.secs} s` : ''}`);
    app.refreshQuotas();
    await follow(spec.name);
  },

  async rm({ name }) {
    const jobs = jobsNow();
    if (name.toLowerCase() === 'all') {
      if (demos.running) throw new Error('a guided demo is running, and its jobs must stay. Stop it first');
      if (!jobs.length) return print('out', 'There are no jobs in the cell.');
      // An alloc set can only go after the jobs that run in it.
      for (const j of [...jobs.filter((x) => x.type !== 'alloc'), ...jobs.filter((x) => x.type === 'alloc')]) await api.remove(j.id).catch(() => {});
      return print('ok', `removed ${plural(jobs.length, 'job')}`);
    }
    const j = jobs.find((x) => x.name === name);
    if (!j) throw new Error(`there is no job called "${name}". Type "jobs" for the list`);
    await api.remove(j.id);
    print('ok', `removed ${j.name}`);
  },

  jobs() {
    const jobs = [...jobsNow()].sort((a, b) => Number(a.done) - Number(b.done) || b.id - a.id);
    if (!jobs.length) return print('out', 'There are no jobs in the cell.');
    print('pre', table([['JOB', 'USER', 'BAND', 'TASKS'], ...jobs.map((j) => [j.name, j.user, SHORT_BAND[j.band] || j.band, jobStatus(j)])]));
    // Under the list: why the jobs that wait have no machine yet.
    const said = new Set();
    for (const t of store.state?.tasks || []) {
      if (t.state !== 'pending' || !t.reason || said.has(t.job)) continue;
      said.add(t.job);
      print('warn', `${t.job_name} waits: ${whyWaiting(t.reason)}`);
    }
  },

  async drain({ machine: word }) {
    const m = machine(word);
    if (m.status !== 'up') throw new Error(`${m.name} is down`);
    if (m.drain) throw new Error(`${m.name} is already ${m.drain}`);
    const n = tasksOn(m);
    await api.drain(m.id);
    print('ok', `${m.name} is draining: ${n ? `its ${plural(n, 'task')} move to other machines, and ` : ''}no new task is placed on it`);
  },

  async undrain({ machine: word }) {
    const m = machine(word);
    if (!m.drain) throw new Error(`${m.name} is not being drained`);
    await api.undrain(m.id);
    print('ok', `${m.name} is back in service`);
  },

  async fail({ machine: word, seconds }) {
    const m = machine(word);
    if (m.status !== 'up') throw new Error(`${m.name} is already down`);
    const n = tasksOn(m);
    await api.fail(m.id, seconds);
    print('ok', `${m.name} is down for ${seconds} s. Borg notices that it stopped answering${n ? ` and moves its ${plural(n, 'task')}` : ''}`);
  },

  async quota(req) {
    if (req.user == null) {
      await app.refreshQuotas();
      if (!app.quotas.length) return print('out', 'No quotas are set: every user may ask for anything.');
      return print('pre', table([['USER', 'BAND', 'CPU USED', 'LIMIT'],
        ...app.quotas.map((q) => [q.user === '*' ? 'everyone else' : q.user, SHORT_BAND[q.band] || q.band, num(q.used?.cpu || 0), q.cpu == null ? 'none' : num(q.cpu)])]));
    }
    const band = BANDS[req.band].label.toLowerCase();
    if (req.remove) {
      await api.setQuota({ user: req.user, band: req.band, remove: true });
      print('ok', `removed the ${band} quota of ${req.user}`);
    } else {
      await api.setQuota({ user: req.user, band: req.band, cpu: req.cpu });
      print('ok', `${req.user} may ask for at most ${num(req.cpu)} CPU at ${band} priority. A job that goes over is refused at once`);
    }
    await app.refreshQuotas();
  },

  async policy({ policy }) {
    const [name, how] = POLICY[policy];
    if (store.state?.policy === policy) return print('out', `Scoring is already ${name}.`);
    await api.setPolicy(policy);
    print('ok', `scoring is now ${name}: ${how}. It applies to tasks placed from now on`);
  },

  async reclaim({ on }) {
    if (on === !!store.state?.reclamation?.enabled) return print('out', `Resource reclamation is already ${on ? 'on' : 'off'}.`);
    await api.setReclamation(on);
    print('ok', on
      ? 'resource reclamation is on: room a task reserved but does not use is offered to batch and free work'
      : 'resource reclamation is off: every task keeps all the room it asked for');
  },

  status() {
    const m = store.model, s = store.state;
    if (!m) throw new Error('the Borgmaster does not answer');
    const master = s.master?.replicas?.length ? `${s.master.name} is the elected Borgmaster (${s.master.replicas.length} replicas)` : 'one Borgmaster';
    print('pre', [
      master,
      `${m.machinesUp} of ${m.machines.length} machines up`,
      `${plural(jobsNow().filter((j) => !j.done).length, 'job')}: ${plural(m.running, 'task')} running, ${m.waiting} waiting in the queue`,
      `scoring ${POLICY[s.policy]?.[0] || s.policy}, resource reclamation ${s.reclamation?.enabled ? 'on' : 'off'}`,
    ].join('\n'));
  },

  clear() {
    lines.length = 0;
    flush();
  },

  help({ topic }) {
    if (topic === 'run') {
      return print('pre', `run <name> [options]\n${table(RUN_OPTIONS.map(([o, what]) => [`  ${o}`, what]))}\nexample: run web --tasks 3 --cpu 0.25 --spread`);
    }
    const about = COMMANDS.filter(([name]) => name === topic);
    print('pre', table((about.length ? about : COMMANDS).map(([, usage, what]) => [usage, what])));
    if (!about.length) print('out', 'A machine can be named by its number: drain 2. "help run" lists the options of run.');
  },
};

// Runs one line: prints it as typed, then what it did.
async function exec(text) {
  const line = String(text || '').trim();
  if (!line || busy) return;
  if (history[history.length - 1] !== line) history.push(line);
  at = -1;
  print('cmd', line);
  const req = parse(line);
  if (req.error) return print('err', sentence(req.error));
  busy = true;
  app.render();
  try {
    await RUN[req.cmd](req);
  } catch (e) {
    print('err', sentence(e.message));
  } finally {
    busy = false;
    await store.refresh();
    app.render();
  }
}

// A shortcut: the command appears at the prompt, as if typed, and then runs.
async function typeAndRun(cmd) {
  const input = $('k-in');
  if (!input || busy) return;
  input.value = cmd;
  input.focus();
  await sleep(260);
  input.value = typed = '';
  exec(cmd);
}

// ---- the panes ------------------------------------------------------------------------------------

function mount() {
  return `<section class="pane" id="p-left"><h2>SHORTCUTS</h2>
      <div class="pane-b" id="k-keys"></div>
      <p class="pane-f">A shortcut types its command at the prompt and runs it.</p>
    </section>
    <section class="pane" id="p-mid"><h2>CONSOLE</h2>
      <div class="pane-b term" id="k-term">
        <div id="k-out"></div>
        <form class="prompt" id="k-form" autocomplete="off">
          <label for="k-in">borg&gt;</label>
          <input id="k-in" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" aria-label="Command">
        </form>
      </div>
    </section>`;
}

function mounted() {
  const input = $('k-in'), term = $('k-term');
  shown = 0;
  if (!lines.length) {
    lines.push({ cls: 'out', text: 'Drive the cell yourself: type a command, or use a shortcut on the left.' },
      { cls: 'out', text: 'Type "help" for the list of commands.' });
  }
  flush();
  input.value = typed;
  $('k-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (busy) return;
    const line = input.value;
    input.value = typed = '';
    exec(line);
  });
  input.addEventListener('input', () => {
    typed = input.value;
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    ev.preventDefault();
    if (!history.length) return;
    if (ev.key === 'ArrowUp') at = at < 0 ? history.length - 1 : Math.max(0, at - 1);
    else at = at < 0 || at >= history.length - 1 ? -1 : at + 1;
    input.value = typed = at < 0 ? '' : history[at];
  });
  // A click anywhere in the console puts the cursor at the prompt (unless text is being selected).
  term.addEventListener('click', () => {
    if (!String(window.getSelection())) input.focus();
  });
  input.focus();
}

function shortcuts() {
  const s = store.state;
  if (!s) return '<p class="none">Connecting to the Borgmaster…</p>';
  const off = busy ? ' disabled' : '';
  const key = (label, cmd) => `<button type="button" class="key" data-act="type" data-cmd="${esc(cmd)}" title="${esc(`borg> ${cmd}`)}"${off}>${esc(label)}</button>`;
  const pick = (label, cmd, on) => `<button type="button" class="${on ? 'on' : ''}" data-act="type" data-cmd="${esc(cmd)}" title="${esc(`borg> ${cmd}`)}" aria-pressed="${on}"${off}>${label}</button>`;
  const taken = new Set((s.jobs || []).map((j) => j.name));
  const fill = clamp(fitCount(s.machines, 0.3, 96), 4, 40);
  const big = Math.max(1, ...(s.machines || []).map((m) => m.capacity?.cpu || 0)) + 1;

  // The machines the shortcuts act on: the first one in service to drain, the last one to take
  // down, so the two stay the same from one second to the next.
  const all = store.model.machines;
  const inService = all.filter((m) => m.state === 'up');
  const toDrain = inService[0], toFail = inService.length > 1 ? inService[inService.length - 1] : null;
  const drained = all.filter((m) => m.up && m.drain);
  const machines = [
    toDrain ? key(`Drain ${toDrain.name}`, `drain ${toDrain.name}`) : '',
    ...drained.map((m) => key(`Put back ${m.name}`, `undrain ${m.name}`)),
    toFail ? key(`Take down ${toFail.name}`, `fail ${toFail.name}`) : '',
  ].join('') || '<p class="none">No machine is in service.</p>';

  const limited = app.quotas.some((q) => q.user === 'ann' && q.band === 'production');
  const policy = s.policy || 'hybrid';
  const reclaim = !!s.reclamation?.enabled;
  return `<h3>JOBS</h3>
    ${key('Web service', `run ${freeName('web', taken)} --tasks 3 --cpu 0.25 --mem 128 --spread`)}
    ${key('Batch job', `run ${freeName('batch', taken)} --tasks 6 --cpu 0.2 --mem 64 --secs 60`)}
    ${key('Fill the cell', `run ${freeName('filler', taken)} --tasks ${fill} --cpu 0.3 --mem 96 --secs 180`)}
    ${key('Too big for any machine', `run ${freeName('giant', taken)} --cpu ${num(big)} --mem 256`)}
    ${key('Remove all jobs', 'rm all')}
    <h3>MACHINES</h3>${machines}
    <h3>QUOTA</h3>
    ${limited ? key("Remove ann's limit", 'quota ann prod off') : key('Limit ann to 0.5 CPU', 'quota ann prod 0.5')}
    <h3>SCORING</h3>
    <div class="seg">${pick('HYBRID', 'policy hybrid', policy === 'hybrid')}${pick('BEST FIT', 'policy best-fit', policy === 'best_fit')}${pick('WORST FIT', 'policy worst-fit', policy === 'worst_fit')}</div>
    <h3>RECLAMATION</h3>
    <div class="seg">${pick('ON', 'reclaim on', reclaim)}${pick('OFF', 'reclaim off', !reclaim)}</div>`;
}

function update() {
  put('k-keys', shortcuts());
  const form = $('k-form');
  if (form) form.classList.toggle('busy', busy);
  app.refreshQuotas(2500); // a guided demo may set one too
}

// Handles a click in the console's panes. Returns true when the action was one of its own.
function act(name, el) {
  if (name !== 'type') return false;
  typeAndRun(el.dataset.cmd);
  return true;
}

export const konsole = { mount, mounted, update, act };
