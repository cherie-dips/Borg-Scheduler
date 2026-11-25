// Guided demos: one short scenario per Borg feature. Each demo talks to the Borgmaster itself
// and says what just happened, one plain line per step. Nothing here touches the page: the
// page passes in how to print and what to highlight, so the same scripts run under
// `node --test` and from tests/ui/demo-live.mjs against a real cell.
//
// Every job a demo starts is named <prefix>… (demo-names-server, demo-health-web, …) so that
// `clean` can find and remove them.

import { num } from '../lib/format.js';

// ---- small pure helpers (unit-tested) ---------------------------------------------------------

const jobOf = (state, name) => (state.jobs || []).find((j) => j.name === name) || null;
const tasksOf = (state, name) => (state.tasks || []).filter((t) => t.job_name === name).sort((a, b) => a.index - b.index);

// The client workload's status line: "ok 45 · failed 0 · last: 0.web.ann.cc at 10.0.0.3:20101".
export function clientNote(note) {
  const m = String(note || '').match(/^ok (\d+) · failed (\d+) · last: (.*)$/);
  return m ? { ok: Number(m[1]), failed: Number(m[2]), last: m[3] } : null;
}

// How many tasks of this size fit into what is free right now, machine by machine.
export function fitCount(machines, cpu, ramMb) {
  let n = 0;
  for (const m of machines || []) {
    if (m.status !== 'up' || m.drain) continue;
    const byCpu = Math.floor((m.capacity.cpu - m.allocated.cpu + 1e-6) / cpu);
    const byRam = Math.floor((m.capacity.ram - m.allocated.ram + 1e-6) / ramMb);
    n += Math.max(0, Math.min(byCpu, byRam));
  }
  return n;
}

// The order in which the scheduler placed the tasks of some jobs, as a list of labels.
// `labels` maps job name -> label; events are the Borgmaster's ("web/3 -> borglet-2, port 20100").
export function fairOrder(events, labels) {
  const out = [];
  for (const e of events || []) {
    if (e.kind !== 'schedule') continue;
    const m = e.msg.match(/^(\S+)\/\d+ -> /);
    if (m && m[1] in labels) out.push(labels[m[1]]);
  }
  return out;
}

// The machine to drain: the one running most tasks of `job`; among equals, the one with the
// fewest other tasks (less collateral), then by name.
export function pickDrainMachine(state, job) {
  const mine = new Map(), others = new Map();
  for (const t of state.tasks || []) {
    if (t.machine < 0 || !['starting', 'installing', 'running'].includes(t.state)) continue;
    const map = t.job_name === job ? mine : others;
    map.set(t.machine, (map.get(t.machine) || 0) + 1);
  }
  const rows = (state.machines || []).filter((m) => m.status === 'up' && !m.drain && mine.has(m.id))
    .map((m) => ({ id: m.id, name: m.name, count: mine.get(m.id), others: others.get(m.id) || 0 }));
  rows.sort((a, b) => b.count - a.count || a.others - b.others || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return rows[0] || null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- the runner ---------------------------------------------------------------------------------

// A demo that cannot go on: the message says why, in plain words.
export class DemoStop extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DemoRunner {
  // api: the REST client. out (all optional): line(text, cls) prints a line; stage(n, of): the
  // demo reached step n of its outline; point(kind, id): it is about this 'job' or 'machine';
  // refresh(): the cell just changed.
  // storage: {get(), set(names)} remembers machines a demo drained and settings it changed, so
  // `clean` can put them back even after a page reload.
  // pace: 1 = pauses as written; tests pass 0 so that reading time is not waited for.
  // minGap: seconds every narrated step stays on screen before the demo moves on (for an
  // audience); 0 = as fast as the cell goes.
  constructor({ api, out = {}, prefix = 'demo-', storage = null, pollMs = 400, pace = 1, minGap = 0 }) {
    this.api = api;
    this.minGap = minGap;
    this.lastSay = 0;
    this.out = out;
    this.prefix = prefix;
    this.pollMs = pollMs;
    this.pace = pace;
    this.storage = storage || { names: [], get() { return this.names; }, set(v) { this.names = v; } };
    this.current = null;     // key of the demo that is running
    this.cancelled = false;
    this.step = 0;
  }

  get running() {
    return this.current;
  }

  line(text, cls = '') {
    this.out.line?.(text, cls);
  }

  // One numbered line per step, as it happens.
  say(text) {
    this.check();
    this.step++;
    this.lastSay = Date.now();
    this.line(`${String(this.step).padStart(2)} ▸ ${text}`);
    this.refresh();
  }

  // Lets the views catch up with what the demo just did; a failure there must not stop the demo.
  refresh() {
    Promise.resolve().then(() => this.out.refresh?.()).catch(() => {});
  }

  check() {
    if (this.cancelled) throw new DemoStop('you stopped it');
  }

  // Polls the cell until test(state) returns something truthy, and returns that.
  // tolerate: keep polling while the Borgmaster does not answer (it is being replaced).
  async until(what, test, { timeout = 30, tolerate = false } = {}) {
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      this.check();
      let state = null;
      try {
        state = await this.api.state();
      } catch (e) {
        if (!tolerate || ![0, 502, 503].includes(e.status)) throw e;
      }
      const v = state && test(state);
      if (v) {
        await this.dwell();
        return v;
      }
      if (Date.now() > deadline) throw new DemoStop(`waited ${timeout} s for ${what}, but it did not happen (is the cell busy or full?)`);
      await sleep(this.pollMs);
    }
  }

  // Waits until the last narrated step has been on screen for minGap seconds.
  async dwell() {
    const until = this.lastSay + this.minGap * 1000 * this.pace;
    while (Date.now() < until) {
      this.check();
      await sleep(Math.min(200, until - Date.now()));
    }
  }

  // The helpers a demo script gets.
  context() {
    const r = this, { api, prefix } = this;
    return {
      api,
      name: (suffix) => `${prefix}${suffix}`,
      user: prefix.replace(/-+$/, '') || 'demo',
      say: (text) => r.say(text),
      aside: (text) => r.line(`     ${text}`, 'dim'),
      // The demo reached step n (1, 2, …) of its outline (`steps` in DEMOS).
      step: (n) => r.out.stage?.(n, demoByKey(r.current)?.steps.length || 0),
      // Something the presenter has to do by hand, e.g. in a terminal.
      ask(text) {
        r.check();
        r.line(`   ☛ ${text}`, 'ask');
      },
      // What the demo is about right now, so a page can highlight it.
      point: (kind, id) => r.out.point?.(kind, id),
      until: (what, test, opts) => r.until(what, test, opts),
      async pause(seconds) {
        const end = Date.now() + seconds * 1000 * r.pace;
        while (Date.now() < end) {
          r.check();
          await sleep(Math.min(200, end - Date.now()));
        }
        await r.dwell();
      },
      async submit(spec) {
        r.check();
        return (await api.submit(spec)).id;
      },
      tasks: tasksOf,
      // The job, or a clear stop if someone removed it meanwhile.
      need(state, name) {
        const j = jobOf(state, name);
        if (!j) throw new DemoStop(`${name} is gone: it was removed while the demo ran`);
        return j;
      },
      // The cell right now; stops the demo when there are too few machines to show anything.
      async cell({ machines = 1 } = {}) {
        const s = await api.state();
        const usable = (s.machines || []).filter((m) => m.status === 'up' && !m.drain).length;
        if (usable < machines) throw new DemoStop(`this demo needs ${plural(machines, 'machine')} in service, and the cell has ${usable}`);
        return s;
      },
      // ip:port and machine of a running task.
      where(state, task) {
        const m = (state.machines || []).find((x) => x.id === task.machine);
        return { machine: task.machine_name, addr: `${m?.ip || '?'}:${task.ports[0]}` };
      },
      remember: (machine) => r.storage.set([...new Set([...r.storage.get(), machine])]),
      forget: (machine) => r.storage.set(r.storage.get().filter((n) => n !== machine)),
    };
  }

  // Runs one demo from start to finish. Resolves to {ok, text}: the closing line.
  async run(key) {
    const demo = demoByKey(key);
    if (!demo) return { ok: false, text: `there is no demo called "${key}" · demos: ${DEMOS.map((d) => d.key).join(', ')}` };
    if (this.current) return { ok: false, text: `demo ${this.current} is still running · stop it first` };
    this.current = demo.key;
    this.cancelled = false;
    this.step = 0;
    this.line(`◈ demo ${demo.key}: ${demo.blurb}`, 'hl');
    let result;
    try {
      const left = await this.clean();
      if (left.jobs || left.quotas || left.machines) this.line(`     (first cleared what an earlier demo left: ${describe(left)})`, 'dim');
      const hint = await demo.run(this.context());
      result = { ok: true, text: `demo ${demo.key} finished${hint ? ` · ${hint}` : ''} · its jobs stay so you can look around; "Clean up" removes them` };
    } catch (e) {
      if (this.cancelled) {
        const left = await this.clean().catch(() => ({}));
        result = { ok: false, text: `demo ${demo.key} stopped${describe(left) ? ` · removed ${describe(left)}` : ''}` };
      } else {
        // DemoStop: the script gave up. A status: the Borgmaster refused (0 = it did not answer).
        const why = e instanceof DemoStop || e.status === 0 ? e.message
          : typeof e.status === 'number' ? `the Borgmaster said: ${e.message}` : `something unexpected went wrong (${e.message})`;
        result = { ok: false, text: `demo ${demo.key} stopped early: ${why} · "Clean up" removes what it started` };
      }
    } finally {
      this.current = null;
      this.cancelled = false;
    }
    this.line(`${result.ok ? '✓' : '✗'} ${result.text}`, result.ok ? 'ok' : 'err');
    this.refresh();
    return result;
  }

  // Asks the running demo to stop; it cleans up after itself.
  stop() {
    if (!this.current) return false;
    this.cancelled = true;
    return true;
  }

  // Removes everything demos leave behind: their jobs, the quotas of their users, and puts
  // machines they drained (and settings they changed) back. Returns what it removed.
  async clean() {
    const { api, prefix } = this;
    const s = await api.state();
    const jobs = (s.jobs || []).filter((j) => j.name.startsWith(prefix));
    // An alloc set can only go after the jobs that run in it.
    for (const j of [...jobs.filter((x) => x.type !== 'alloc'), ...jobs.filter((x) => x.type === 'alloc')]) await api.remove(j.id).catch(() => {});
    const q = await api.quota().catch(() => null);
    const quotas = (q?.quotas || []).filter((row) => row.user.startsWith(prefix));
    for (const row of quotas) await api.setQuota({ user: row.user, band: row.band, remove: true }).catch(() => {});
    let machines = 0, settings = 0;
    for (const name of this.storage.get()) {
      const was = /^reclamation=(on|off):([\d.]+)$/.exec(name); // a setting a demo changed
      if (was) {
        await api.setReclamation(was[1] === 'on', Number(was[2])).catch(() => {});
        settings++;
        continue;
      }
      const m = (s.machines || []).find((x) => x.name === name);
      if (m && m.drain) {
        await api.undrain(m.id).catch(() => {});
        machines++;
      }
    }
    this.storage.set([]);
    return { jobs: jobs.length, quotas: quotas.length, machines, ...(settings ? { settings } : {}) };
  }
}

export function describe(left = {}) {
  return [
    left.jobs ? plural(left.jobs, 'job') : '',
    left.quotas ? plural(left.quotas, 'quota') : '',
    left.machines ? `${plural(left.machines, 'machine')} put back in service` : '',
    left.settings ? 'resource reclamation set back' : '',
  ].filter(Boolean).join(', ');
}

// ---- the demos ------------------------------------------------------------------------------------
// Demo jobs run at production priority so they start even in a busy cell, and they are tiny.

const STEP = 2.5; // seconds to leave a line on screen when the next step would follow at once

const server = (name, user, tasks, extra = {}) => ({
  name, user, type: 'service', priority: 200, tasks, cpu: 0.1, ram_mb: 48, workload: { type: 'service' }, ...extra,
});
const allRunning = (d, name, n) => (s) => {
  d.need(s, name);
  const ts = d.tasks(s, name);
  return ts.length === n && ts.every((t) => t.state === 'running') ? { s, ts } : null;
};

async function names(d) {
  const srv = d.name('names-server'), cli = d.name('names-client');
  await d.cell();
  d.step(1);
  d.say(`Starting ${srv}: one small web server. Borg picks a machine and a port for it.`);
  const id = await d.submit(server(srv, d.user, 1));
  const up = await d.until(`${srv} to start`, (s) => {
    const t = d.tasks(s, srv)[0];
    return t && t.state === 'running' && t.ports.length ? { s, t } : null;
  });
  const before = d.where(up.s, up.t);
  d.say(`It runs. Its name is ${up.t.name}; right now that name leads to ${before.addr} on ${before.machine}.`);

  d.step(2);
  d.say(`Starting ${cli}: it knows only the job's name. It asks Borg's name service for the address and calls the server twice a second.`);
  await d.submit({ name: cli, user: d.user, type: 'service', priority: 200, tasks: 1, cpu: 0.05, ram_mb: 32, workload: { type: 'client', target: srv, rps: 2 } });
  const first = await d.until(`${cli} to get answers`, (s) => {
    d.need(s, cli);
    const n = clientNote(d.tasks(s, cli)[0]?.note);
    return n && n.ok >= 3 ? n : null;
  });
  d.say(`The client gets answers: ${plural(first.ok, 'call')} worked, ${first.failed} failed.`);

  d.step(3);
  d.say('Now the server freezes: we make it stop answering. Borg checks it every 2 seconds, and after 3 misses it replaces it.');
  await d.api.poke(id, { action: 'hang', index: 0 });
  const restartsBefore = up.t.restarts;
  const moved = await d.until(`Borg to replace ${srv}`, (s) => {
    d.need(s, srv);
    const t = d.tasks(s, srv)[0];
    return t && t.restarts > restartsBefore && t.state === 'running' && t.ports.length ? { s, t } : null;
  }, { timeout: 60 });
  const after = d.where(moved.s, moved.t);
  const okThen = clientNote(d.tasks(moved.s, cli)[0]?.note)?.ok ?? 0;
  d.say(after.addr !== before.addr
    ? `Borg replaced it on ${after.machine}. Same name, new address: ${moved.t.name} now leads to ${after.addr}.`
    : `Borg restarted it in the same place, so ${moved.t.name} still leads to ${after.addr}.`);
  d.step(4);

  const again = await d.until(`${cli} to reach the server again`, (s) => {
    d.need(s, cli);
    const n = clientNote(d.tasks(s, cli)[0]?.note);
    return n && n.ok > okThen && n.last.includes(` at ${after.addr}`) ? n : null;
  }, { timeout: 40 });
  d.say(`The client found it by itself: ${plural(again.ok, 'call')} worked so far, ${again.failed} failed${again.failed ? ' (the seconds without a server)' : ''}. Nobody told it the new address.`);
  return '';
}

async function health(d) {
  const web = d.name('health-web');
  await d.cell();
  d.step(1);
  d.say(`Starting ${web}: 2 copies of a small web server. Every 2 seconds Borg asks each copy "are you OK?" (a health check).`);
  const id = await d.submit(server(web, d.user, 2));
  d.point('job', id);
  await d.until('both copies to pass their health check', (s) => {
    d.need(s, web);
    const ts = d.tasks(s, web);
    return ts.length === 2 && ts.every((t) => t.state === 'running' && t.healthy === 1);
  }, { timeout: 40 });
  d.say('Both copies answer their health checks.');

  d.step(2);
  d.say('Breaking copy 0 on purpose: from now on it answers the health check with an error.');
  await d.api.poke(id, { action: 'sick', index: 0 });
  d.step(3);
  const seen = await d.until('Borg to notice the failing copy', (s) => {
    d.need(s, web);
    const t = d.tasks(s, web)[0];
    return t && (t.healthy === 0 || t.restarts > 0) ? t : null;
  }, { timeout: 30 });
  if (!seen.restarts) d.say('Borg noticed at its next check: copy 0 now reads "failing". Copy 1 keeps serving.');

  const stopped = await d.until('Borg to stop the failing copy', (s) => {
    d.need(s, web);
    const t = d.tasks(s, web)[0];
    return t && t.restarts > 0 ? t : null;
  }, { timeout: 40 });
  d.say(`3 failed checks in a row: Borg stopped copy 0 and starts a fresh one (restart ${stopped.restarts}).`);

  const back = await d.until('the fresh copy to be healthy', (s) => {
    d.need(s, web);
    const t = d.tasks(s, web)[0];
    return t && t.state === 'running' && t.healthy === 1 ? t : null;
  }, { timeout: 60 });
  const avoids = (back.avoid || []).length ? ` Borg will not put it back on ${back.avoid.join(', ')}, where it failed.` : '';
  d.say(`The fresh copy 0 runs on ${back.machine_name} and passes its health checks again.${avoids} Nobody had to step in.`);
  return '';
}

async function quota(d) {
  const ann = d.name('ann'), web = d.name('quota-web'), big = d.name('quota-big');
  await d.cell();
  d.step(1);
  d.say(`Giving user ${ann} a quota: at most 0.5 CPU cores of production-priority work.`);
  await d.api.setQuota({ user: ann, band: 'production', cpu: 0.5 });
  await d.pause(STEP); // nothing to wait for here: leave time to read each step

  d.step(2);
  d.say(`${ann} starts ${web}: 3 tasks × 0.1 CPU = 0.3 cores. That is within the quota, so Borg accepts it.`);
  await d.submit(server(web, ann, 3, { ram_mb: 32 }));
  await d.pause(STEP);

  d.step(3);
  d.say(`${ann} asks for 0.3 more cores with ${big}. Only 0.2 are left in the quota…`);
  let refused = null;
  try {
    await d.submit(server(big, ann, 3, { ram_mb: 32 }));
  } catch (e) {
    if (e.status !== 403) throw e;
    refused = e.message;
  }
  if (!refused) throw new DemoStop(`Borg accepted ${big} although it is over quota`);
  d.say(`Borg refused it at once, before any scheduling: "${refused}"`);
  await d.pause(STEP);

  d.step(4);
  d.say('The same job at free priority (the lowest band) is accepted: that band has no quota. The price: it is the first to be pushed out when the cell is full.');
  await d.submit(server(big, ann, 3, { ram_mb: 32, priority: 0 }));
  return `${ann} now uses 0.3 of the 0.5 cores of the quota`;
}

async function after(d) {
  const one = d.name('after-first'), two = d.name('after-second');
  await d.cell();
  d.step(1);
  d.say(`Starting ${one}: a batch job that takes 10 seconds (say, it prepares some data).`);
  await d.submit({ name: one, user: d.user, type: 'batch', priority: 100, tasks: 1, cpu: 0.1, ram_mb: 32, workload: { type: 'sleep', duration: 10 } });
  d.step(2);
  d.say(`Starting ${two} with the rule "start after ${one}". Borg accepts it but holds it back: its tasks read "waiting".`);
  const id = await d.submit({ name: two, user: d.user, type: 'batch', priority: 100, tasks: 2, cpu: 0.1, ram_mb: 32, after: one, workload: { type: 'sleep', duration: 10 } });
  d.point('job', id);

  await d.until(`${one} to finish`, (s) => {
    const j = d.need(s, one);
    if (j.status === 'failed' || j.status === 'killed') throw new DemoStop(`${one} ${j.status === 'failed' ? 'failed' : 'was stopped'}, so ${two} stays blocked`);
    return j.status === 'completed';
  }, { timeout: 60 });
  d.step(3);
  d.say(`${one} has finished.`);
  await d.until(`${two} to start`, (s) => {
    const j = d.need(s, two);
    return (j.status === 'running' || j.status === 'completed') && d.tasks(s, two).some((t) => t.state === 'running' || t.state === 'finished');
  }, { timeout: 40 });
  d.say(`Borg released ${two} at once: its 2 tasks are running now. Nobody had to watch the first job.`);
  return '';
}

async function overrides(d) {
  const web = d.name('overrides-web');
  await d.cell();
  d.step(1);
  d.say(`Starting ${web}: 3 tasks that ask for 0.1 CPU and 32 MB each, except task 2, which gets its own size: 0.3 CPU and 96 MB.`);
  const id = await d.submit(server(web, d.user, 3, { ram_mb: 32, overrides: { 2: { cpu: 0.3, ram_mb: 96 } } }));
  d.point('job', id);
  const { ts } = await d.until('all 3 tasks to run', allRunning(d, web, 3), { timeout: 40 });
  d.step(2);
  d.say(`All 3 run. What each task asks for: ${ts.map((t) => `task ${t.index} ${num(t.cpu)} cpu · ${t.ram_mb} MB`).join(', ')}.`);
  d.say('One job and one set of names, but not every task has to be the same size: useful when one task does more work than the others.');
  return '';
}

async function update(d) {
  const web = d.name('update-web'), n = 4;
  await d.cell();
  d.step(1);
  d.say(`Starting ${web}: ${n} copies of a web server with 32 MB of memory each.`);
  const id = await d.submit(server(web, d.user, n, { ram_mb: 32 }));
  d.point('job', id);
  await d.until(`all ${n} copies to run`, allRunning(d, web, n), { timeout: 40 });

  d.step(2);
  d.say('Giving every copy 48 MB instead. A new size needs a restart, so Borg does a rolling update: one copy at a time, while the others keep serving.');
  await d.api.edit(id, { ram_mb: 48, rolling: { max_unavailable: 1 } });
  let worst = 0, half = false;
  await d.until('the rolling update to finish', (s) => {
    const j = d.need(s, web), ts = d.tasks(s, web);
    const down = ts.filter((t) => t.state !== 'running').length;
    const old = ts.filter((t) => t.outdated).length;
    worst = Math.max(worst, down);
    if (!half && old > 0 && old <= n / 2) {
      half = true;
      d.say(`Half way: ${n - old} of ${n} copies are on the new version; ${old} still wait${old === 1 ? 's' : ''} for ${old === 1 ? 'its' : 'their'} turn (marked "old version").`);
    }
    return !j.update.rolling && old === 0 && down === 0;
  }, { timeout: 120 });
  d.say(`Done: all ${n} copies run with 48 MB. ${worst <= 1 ? 'Never more than 1 copy was down at a time.' : `At most ${worst} copies were down at a time.`}`);

  d.step(3);
  d.say('Now we change our mind. Undo: Borg goes back to 32 MB, again one copy at a time.');
  await d.api.updateJob(id, 'undo');
  await d.until('the roll-back to finish', (s) => {
    const j = d.need(s, web), ts = d.tasks(s, web);
    return !j.update.rolling && j.ram_mb === 32 && ts.length === n && ts.every((t) => t.state === 'running' && !t.outdated);
  }, { timeout: 120 });
  d.say(`Rolled back: all ${n} copies run with 32 MB again.`);
  return '';
}

async function drain(d) {
  const web = d.name('drain-web'), n = 6;
  await d.cell({ machines: 2 });
  d.step(1);
  d.say(`Starting ${web}: ${n} copies of a web server. Borg spreads them over the machines.`);
  await d.submit(server(web, d.user, n, { cpu: 0.05, ram_mb: 32 }));
  const { s } = await d.until(`all ${n} copies to run`, allRunning(d, web, n), { timeout: 60 });
  const pick = pickDrainMachine(s, web);
  if (!pick) throw new DemoStop(`cannot tell which machine runs ${web}`);
  d.point('machine', pick.id);
  d.step(2);
  d.say(`${pick.name} runs ${pick.count} of them${pick.others ? ` (and ${plural(pick.others, 'task')} of other jobs)` : ''}. It needs maintenance, so we drain it: it gets no new tasks, and Borg moves its tasks away one at a time.`);

  d.remember(pick.name); // so that "demo clean" can put it back if this demo is cut short
  await d.api.drain(pick.id, 1);
  let least = n, done = false;
  try {
    await d.until(`${pick.name} to be empty`, (state) => {
      d.need(state, web);
      least = Math.min(least, d.tasks(state, web).filter((t) => t.state === 'running').length);
      return (state.machines || []).find((m) => m.id === pick.id)?.drain === 'drained';
    }, { timeout: 90 });
    d.step(3);
    d.say(`${pick.name} is empty (it reads "Drained") and safe to switch off. Its tasks run on other machines now; at least ${least} of ${n} copies were serving the whole time.`);
    done = true;
  } finally {
    await d.api.undrain(pick.id).catch(() => {});
    d.forget(pick.name);
    if (!done) d.aside(`(${pick.name} was put back in service)`);
  }
  d.say(`Maintenance over: ${pick.name} is back in service and can take new tasks again.`);
  return '';
}

async function crash(d) {
  const app = d.name('crash-app');
  await d.cell({ machines: 2 });
  d.step(1);
  d.say(`Starting ${app}: one task. Borg picks a machine for it.`);
  const id = await d.submit(server(app, d.user, 1));
  d.point('job', id);
  const up = await d.until(`${app} to run`, (s) => {
    d.need(s, app);
    const t = d.tasks(s, app)[0];
    return t && t.state === 'running' ? t : null;
  }, { timeout: 40 });
  let bad = up.machine_name;
  d.step(2);
  d.say(`It runs on ${bad}. Now we ship a broken version that crashes whenever it runs on ${bad} (think: a faulty disk or a missing file on that machine).`);

  for (let tries = 0; ; tries++) {
    await d.api.edit(id, { workload: { type: 'service', crash_on: bad }, rolling: false });
    await d.api.updateJob(id, 'commit').catch(() => {}); // this change is the point: no undo offered
    const r = await d.until(`${app} to crash on ${bad}`, (s) => {
      d.need(s, app);
      const t = d.tasks(s, app)[0];
      if (!t) return null;
      if ((t.avoid || []).includes(bad) || t.restarts > 0) return { crashed: true };
      // Borg happened to restart it somewhere else, where this version does not crash.
      if (t.state === 'running' && !t.outdated && t.machine_name !== bad && s.time - t.started > 3) return { elsewhere: t.machine_name };
      return null;
    }, { timeout: 60 });
    if (r.crashed) break;
    if (tries >= 2) throw new DemoStop(`Borg keeps restarting ${app} on a different machine, so it never meets the one it crashes on; try again when the cell is quieter`);
    bad = r.elsewhere;
    d.aside(`(Borg restarted it on ${bad} this time, so the broken version now crashes there instead)`);
  }
  d.step(3);
  d.say(`It started on ${bad} again and crashed. Borg noted the pair "this task on ${bad}" and will not place it there again.`);

  const ok = await d.until(`${app} to run on another machine`, (s) => {
    d.need(s, app);
    const t = d.tasks(s, app)[0];
    return t && t.state === 'running' && t.machine_name !== bad && s.time - t.started > 2 ? t : null;
  }, { timeout: 60 });
  d.say(`Borg restarted it on ${ok.machine_name}, where it runs fine. From now on this task avoids ${(ok.avoid || [bad]).join(', ')}.`);
  return '';
}

async function fair(d) {
  const ann = d.name('ann'), bob = d.name('bob'), ja = d.name('fair-ann'), jb = d.name('fair-bob');
  const cpu = 0.6, ram = 32;
  const s = await d.cell();
  const room = fitCount(s.machines, cpu, ram);
  if (room < 2) throw new DemoStop(`the cell is too full: this demo needs room for at least 2 tasks of ${cpu} CPU. Remove some jobs and try again`);
  const each = Math.min(room, 10);
  d.step(1);
  d.say(`Two users, ${ann} and ${bob}, each ask for ${each} tasks of ${cpu} CPU at the same priority. The cell has room for about ${room} such tasks, not ${2 * each}.`);
  const mark = (await d.api.events(Number.MAX_SAFE_INTEGER)).last || 0;
  const at = s.time + 4;
  for (const [name, user] of [[ja, ann], [jb, bob]]) {
    await d.submit({ name, user, type: 'batch', priority: 0, tasks: each, cpu, ram_mb: ram, start_at: at, workload: { type: 'sleep', duration: 30 } });
  }
  d.step(2);
  d.say('Both jobs are set to start at the same moment, 4 seconds from now, so neither is simply first in line.');

  await d.until('the scheduler to place them', (state) => {
    const a = d.need(state, ja), b = d.need(state, jb);
    const placed = [...d.tasks(state, ja), ...d.tasks(state, jb)].filter((t) => t.machine >= 0).length;
    return a.status !== 'waiting' && b.status !== 'waiting' && placed > 0;
  }, { timeout: 40 });
  await d.pause(2); // let the scheduling pass and its log lines complete
  const order = fairOrder((await d.api.events(mark)).events, { [ja]: 'ann', [jb]: 'bob' });
  if (!order.length) throw new DemoStop('the event log shows no placements for these jobs');
  const got = (who) => order.filter((x) => x === who).length;
  d.step(3);
  d.say(`Borg handed out room one task at a time, taking turns: ${order.join(', ')}.`);
  d.say(`Result: ${ann} got ${got('ann')} and ${bob} got ${got('bob')}. Neither could take the whole cell by asking first; their other tasks wait in the queue until room frees up.`);
  return '';
}

// The classic scenario: fill the cell, then a production job arrives and batch work makes room.
async function tour(d) {
  const web = d.name('tour-web'), crawler = d.name('tour-crawler'), batch = d.name('tour-analytics'), pay = d.name('tour-payments');
  const cpu = 0.3, ram = 96;
  await d.cell({ machines: 4 });
  d.step(1);
  d.say(`Starting ${web}: a production web frontend, 3 copies on 3 different machines. And ${crawler}: 6 tasks at free priority, the lowest there is.`);
  await d.submit({ name: web, user: d.user, type: 'service', priority: 200, tasks: 3, cpu: 0.25, ram_mb: 128, workload: { type: 'service' }, distinct: true });
  await d.submit({ name: crawler, user: d.user, type: 'batch', priority: 0, tasks: 6, cpu: 0.2, ram_mb: 64, workload: { type: 'sleep', duration: 180 } });
  const settled = (s, name) => d.tasks(s, name).every((t) => t.state === 'running' || t.state === 'pending');
  // Both jobs have to be placed before the rest of the cell is measured. In a cell that is
  // already busy the crawler may not fit completely: then go on after a few seconds.
  const t0 = Date.now();
  const first = await d.until('the first two jobs to start', (s) => {
    d.need(s, web);
    d.need(s, crawler);
    const up = (name) => d.tasks(s, name).filter((t) => t.state === 'running').length;
    return up(web) === 3 && (up(crawler) === 6 || (settled(s, crawler) && Date.now() - t0 > 10000)) ? s : null;
  }, { timeout: 60 });

  d.step(2);
  const room = fitCount(first.machines, cpu, ram);
  const n = Math.max(4, Math.min(40, room));
  d.say(`Starting ${batch}: a batch job sized to fill what is left of the cell: ${n} tasks of ${cpu} CPU.`);
  await d.submit({ name: batch, user: d.user, type: 'batch', priority: 100, tasks: n, cpu, ram_mb: ram, workload: { type: 'sleep', duration: 150 } });
  const full = await d.until(`${batch} to fill the cell`, (s) => {
    d.need(s, batch);
    const ts = d.tasks(s, batch);
    return ts.length === n && settled(s, batch) && ts.filter((t) => t.state === 'running').length >= Math.min(n, room) ? s : null;
  }, { timeout: 90 });
  const waiting = d.tasks(full, batch).filter((t) => t.state !== 'running').length;
  d.say(`The cell is full: ${num(full.allocated.cpu)} of its ${num(full.capacity.cpu)} CPU cores are handed out${waiting ? `, and ${plural(waiting, 'task')} of ${batch} wait${waiting === 1 ? 's' : ''} in the queue` : ''}.`);

  d.step(3);
  const mark = (await d.api.events(Number.MAX_SAFE_INTEGER)).last || 0;
  d.say(`In 25 seconds ${pay} arrives: 4 tasks of 0.6 CPU at priority 250, on 4 different machines. No machine has that much room left. Watch its countdown.`);
  await d.submit({ name: pay, user: d.user, type: 'service', priority: 250, tasks: 4, cpu: 0.6, ram_mb: 256, workload: { type: 'service' }, distinct: true, delay: 25 });
  await d.until(`${pay} to arrive`, (s) => d.need(s, pay).status !== 'waiting', { timeout: 50 });

  d.step(4);
  await d.until(`${pay} to run`, (s) => {
    d.need(s, pay);
    const ts = d.tasks(s, pay);
    return ts.length === 4 && ts.every((t) => t.state === 'running');
  }, { timeout: 60 });
  const pushed = (await d.api.events(mark)).events.filter((e) => e.kind === 'preempt');
  const of = (name) => pushed.filter((e) => e.msg.startsWith(`${name}/`)).length;
  d.say(`${pay} runs on 4 machines. To make room, Borg pushed out (preempted) ${plural(pushed.length, 'lower-priority task')}: ${of(crawler)} of ${crawler} (free) and ${of(batch)} of ${batch} (batch).`);
  d.say(`The pushed-out tasks are back in the queue ("Pending") and start again when room frees up. ${web}, production work, was never touched.`);
  return '';
}

// An alloc: room reserved on a machine that the tasks of several jobs share. It moves as one.
async function allocs(d) {
  const pods = d.name('allocs-pods'), srv = d.name('allocs-server'), saver = d.name('allocs-logsaver');
  await d.cell({ machines: 3 });
  d.step(1);
  d.say(`Starting ${pods}: an alloc set of 2. Each alloc reserves 0.5 CPU and 192 MB on a machine of its own, for other jobs to run in.`);
  const sid = await d.submit({ name: pods, user: d.user, type: 'alloc', priority: 200, tasks: 2, cpu: 0.5, ram_mb: 192, distinct: true });
  d.point('job', sid);
  const up = (s, name) => d.tasks(s, name).filter((t) => t.state === 'running');
  const reserved = await d.until('both allocs to be reserved', (s) => {
    d.need(s, pods);
    const ts = up(s, pods);
    return ts.length === 2 && new Set(ts.map((t) => t.machine)).size === 2 ? ts : null;
  }, { timeout: 40 });
  const home = Object.fromEntries(reserved.map((t) => [t.index, t]));
  d.say(`Both allocs are reserved: alloc 0 on ${home[0].machine_name}, alloc 1 on ${home[1].machine_name}. They hold their room even while they are empty.`);

  d.step(2);
  d.say(`Starting two jobs inside the alloc set: ${srv} (2 web servers) and ${saver} (2 helpers that save the server's log). Task 0 of each job goes into alloc 0, task 1 into alloc 1.`);
  await d.submit({ name: srv, user: d.user, type: 'service', priority: 200, tasks: 2, cpu: 0.2, ram_mb: 64, workload: { type: 'service' }, alloc_set: pods });
  await d.submit({ name: saver, user: d.user, type: 'service', priority: 200, tasks: 2, cpu: 0.1, ram_mb: 32, workload: { type: 'logsaver' }, alloc_set: pods });
  await d.until('the servers and log savers to run', (s) => {
    d.need(s, srv);
    d.need(s, saver);
    return up(s, srv).length === 2 && up(s, saver).length === 2;
  }, { timeout: 40 });
  d.say('Each alloc now holds one server and one log saver, side by side on the same machine. They share the alloc\'s room and a folder: the log saver reads the log the server writes.');
  await d.pause(STEP);

  d.step(3);
  const failed = home[0];
  d.point('machine', failed.machine);
  d.say(`Now ${failed.machine_name}, the machine of alloc 0, fails for 15 seconds.`);
  await d.api.fail(failed.machine, 15);

  d.step(4);
  const moved = await d.until('alloc 0 and its tasks to move', (s) => {
    d.need(s, pods);
    const a = up(s, pods).find((t) => t.index === 0);
    if (!a || a.machine === failed.machine) return null;
    const inside = [...d.tasks(s, srv), ...d.tasks(s, saver)].filter((t) => t.index === 0);
    return inside.length === 2 && inside.every((t) => t.state === 'running' && t.machine === a.machine) ? a : null;
  }, { timeout: 60 });
  d.say(`Borg reserved alloc 0 again, on ${moved.machine_name}, and both its tasks followed it there: the server and its log saver stay together. Alloc 1 on ${home[1].machine_name} never noticed.`);
  await d.until(`${failed.machine_name} to come back`, (s) => (s.machines || []).find((m) => m.id === failed.machine)?.status === 'up', { timeout: 60 });
  d.say(`${failed.machine_name} is back up and can take work again.`);
  return '';
}

// A machine that can be picked by an attribute of its own (e.g. a rack with one machine).
function loneMachine(machines) {
  const usable = (machines || []).filter((m) => m.status === 'up' && !m.drain);
  for (const m of [...usable].sort((a, b) => a.capacity.cpu - b.capacity.cpu || a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    for (const [key, value] of Object.entries(m.attributes || {}).sort()) {
      if (usable.filter((x) => (x.attributes || {})[key] === value).length === 1) return { machine: m, key, value };
    }
  }
  return null;
}

// Resource reclamation: batch work runs in room that production work reserved but does not use,
// and gives it back the moment production work needs it.
async function reclaim(d) {
  const big = d.name('reclaim-service'), fill = d.name('reclaim-batch');
  const s0 = await d.cell();
  const lone = loneMachine(s0.machines);
  if (!lone) throw new DemoStop('this demo needs a machine that can be picked by an attribute of its own (for example a rack with one machine)');
  const m = lone.machine, cap = m.capacity;
  if (m.allocated.cpu > cap.cpu * 0.05 || m.allocated.ram > cap.ram * 0.2) throw new DemoStop(`${m.name} is busy, and this demo needs it nearly empty. Remove some jobs and try again`);
  const only = [{ key: lone.key, value: lone.value, hard: true }];
  const was = s0.reclamation || { enabled: false, warmup: 20 };
  const saved = `reclamation=${was.enabled ? 'on' : 'off'}:${was.warmup}`;
  const bigCpu = Math.round(cap.cpu * 90) / 100, bigRam = Math.floor(cap.ram * 0.75);
  const fillCpu = Math.round(cap.cpu * 50) / 100, fillRam = Math.floor(cap.ram * 0.4), fillUse = Math.floor(cap.ram * 0.33);
  const here = (s) => (s.machines || []).find((x) => x.id === m.id);
  const run = (s, name) => d.tasks(s, name).filter((t) => t.state === 'running');

  d.remember(saved); // so that "Clean up" can set it back if this demo is cut short
  let done = false;
  try {
    d.step(1);
    d.say('Turning resource reclamation on. From 3 seconds after a task starts, Borg reserves only what the task really uses plus a safety margin, not everything it asked for.');
    await d.api.setReclamation(true, 3);

    d.step(2);
    d.point('machine', m.id);
    d.say(`Starting ${big}: a production service that asks for ${num(bigCpu)} of the ${num(cap.cpu)} CPU and ${bigRam} of the ${Math.round(cap.ram)} MB of ${m.name} (the only machine with ${lone.key}=${lone.value}). It will use far less.`);
    const id = await d.submit({ name: big, user: d.user, type: 'service', priority: 200, tasks: 1, cpu: bigCpu, ram_mb: bigRam, workload: { type: 'service' }, constraints: only });
    await d.until(`${big} to run`, (s) => {
      d.need(s, big);
      return run(s, big).length === 1;
    }, { timeout: 40 });

    d.step(3);
    d.say(`Starting ${fill}: a batch task that asks for ${num(fillCpu)} CPU and ${fillRam} MB on the same machine. Together they ask for more than the machine has, so at first it does not fit.`);
    await d.submit({ name: fill, user: d.user, type: 'batch', priority: 100, tasks: 1, cpu: fillCpu, ram_mb: fillRam, workload: { type: 'mem', mb: fillUse, duration: 300 }, constraints: only });
    const fits = await d.until(`the reservation of ${big} to shrink`, (s) => {
      d.need(s, big);
      d.need(s, fill);
      return run(s, fill).length === 1 ? s : null;
    }, { timeout: 60 });
    const mm = here(fits);
    d.say(`The reservation of ${big} shrank to what it really uses, and ${fill} started in the room that freed up. ${m.name}'s tasks now ask for ${num(mm.allocated.cpu)} CPU, more than its ${num(cap.cpu)}, but only ${num(mm.reserved.cpu)} is reserved.`);
    const before = d.tasks(fits, big)[0];
    await d.until(`${fill} to fill its memory`, (s) => {
      d.need(s, fill);
      const t = run(s, fill)[0];
      return t && t.mem_mb > cap.ram * 0.3;
    }, { timeout: 40 });

    d.step(4);
    const mark = (await d.api.events(Number.MAX_SAFE_INTEGER)).last || 0;
    d.say(`Now ${big} suddenly needs the memory it asked for: a spike of ${Math.floor(cap.ram * 0.68)} MB. The machine cannot hold both.`);
    await d.api.poke(id, { action: 'mem', mb: Math.floor(cap.ram * 0.68), seconds: 25 });
    const victim = await d.until(`${m.name} to evict the batch task`, (s) => {
      d.need(s, big);
      d.need(s, fill);
      const t = d.tasks(s, fill)[0];
      return t && (t.preemptions > 0 || /^evicted/.test(t.reason || '')) ? { s, t } : null;
    }, { timeout: 45 });
    const said = (await d.api.events(mark)).events.find((e) => e.kind === 'evict')?.msg || victim.t.reason;
    const after = d.tasks(victim.s, big)[0];
    const kept = after && after.state === 'running' && after.attempt === before.attempt;
    d.say(`${m.name} ran out of memory and stopped the batch task, not the production one ("${said}"). ${kept ? `${big} never stopped.` : `(${big} was restarted too, which should not happen.)`} The batch task is back in the queue.`);
    done = true;
  } finally {
    await d.api.setReclamation(was.enabled, was.warmup).catch(() => {});
    d.forget(saved);
    if (!done) d.aside(`(resource reclamation was set back to ${was.enabled ? 'on' : 'off'})`);
  }
  d.step(5);
  d.say(was.enabled
    ? 'Resource reclamation is back to how it was before the demo.'
    : `Resource reclamation is off again: every task gets everything it asked for reserved, so ${fill} no longer fits next to ${big} and waits in the queue.`);
  return '';
}

// The elected master is killed by hand; another replica takes over, and no task notices.
async function failover(d) {
  const web = d.name('failover-web'), n = 3;
  const s0 = await d.cell({ machines: 2 });
  const replicas = s0.master?.replicas || [];
  if (replicas.length < 2) throw new DemoStop('this cell has one Borgmaster and no replicas, so there is nobody to take over. Start the cell with replicas (tools/cell.sh start ha) to try this');
  const me = d.api.replica ? await d.api.replica().catch(() => null) : null;
  if (me?.elected) {
    const other = replicas.find((r) => !r.elected);
    throw new DemoStop(`this page is served by ${me.name}, the elected master itself, so killing it would cut the page off too. Open the UI on a replica that follows (for example ${other?.name} at ${other?.url}) and run the demo there`);
  }
  const old = s0.master.name, election = s0.master.election;
  d.step(1);
  d.say(`This cell has ${replicas.length} Borgmaster replicas. ${old} is the elected master${me?.name ? `; this page is served by ${me.name}, which passes every request on to it` : ''}. Starting ${web}: ${n} small web servers.`);
  await d.submit(server(web, d.user, n, { distinct: true }));
  const { ts } = await d.until(`all ${n} servers to run`, allRunning(d, web, n), { timeout: 40 });
  const print = (t) => `${t.machine}/${t.attempt}/${t.started}/${(t.ports || []).join(',')}`;
  const before = new Map(ts.map((t) => [t.id, print(t)]));
  await d.pause(1.5); // the master records every change within a second

  d.step(2);
  d.say(`All ${n} run. Now it is your turn: kill ${old}, the elected master, without warning.`);
  d.ask('In a terminal, run:  tools/cell.sh kill-master');
  d.aside(`(with Docker: docker compose -f docker-compose.ha.yml kill ${old})`);
  const t0 = Date.now();
  // Step 2 stays on screen, with the command, until the presenter has killed the master.
  const next = await d.until('another replica to be elected (run the command above)', (s) => (s.master && s.master.election > election && s.master.name !== old ? s : null), { timeout: 300, tolerate: true });

  d.step(3);
  d.say(`${old} is gone. ${next.master.name} was elected in its place (election ${next.master.election}) and answers now, ${Math.round((Date.now() - t0) / 1000)} seconds after the question above.`);

  d.step(4);
  await d.pause(4); // a few polls: anything the new master had wrong would be restarted by now
  const s = await d.api.state();
  const now = d.tasks(s, web);
  const same = now.length === n && now.every((t) => t.state === 'running' && before.get(t.id) === print(t));
  if (!same) throw new DemoStop(`the new master is elected, but the tasks of ${web} did not all stay as they were: ${now.map((t) => `task ${t.index} ${t.state} (start ${t.attempt})`).join(', ')}`);
  d.say(`No task was restarted: all ${n} servers are the same processes on the same machines and ports as before. Only the master changed; the machines kept running their tasks on their own.`);
  return `start the killed replica again with: tools/cell.sh start-master ${old.replace(/^.*-/, '')}`;
}

// title: the name in the list of demos. steps: the outline shown while it runs (d.step(n) marks
// where the script is). manual: a person has to do something by hand, so "all" skips it.
// offered(state): false when the cell cannot show it.
export const DEMOS = [
  {
    key: 'tour', title: 'The big tour', blurb: 'fill the cell, then watch a production job push out batch work', secs: 40, run: tour,
    steps: ['a production web frontend and a free-priority crawler start', 'a batch job sized to fill the rest of the cell starts', '25 seconds later a priority-250 job arrives: there is no free room for it', 'Borg pushes out (preempts) lower-priority tasks to make room'],
  },
  {
    key: 'names', title: 'Finding a server by name', blurb: 'a client finds a server by its name, even after the server moves', secs: 25, run: names,
    steps: ['a small web server starts; Borg gives it a machine, a port and a name', 'a client calls it, knowing only the name', 'the server freezes and Borg replaces it on another machine', 'the client finds the new address by itself'],
  },
  {
    key: 'health', title: 'Health checks', blurb: 'Borg checks every server and replaces one that stops working', secs: 20, run: health,
    steps: ['2 copies of a web server start and pass their health checks', 'one copy is broken on purpose', 'Borg sees it failing, stops it after 3 failed checks and starts a fresh copy'],
  },
  {
    key: 'quota', title: 'Quota', blurb: 'a job that would take its user over quota is refused at once', secs: 15, run: quota,
    steps: ['a user gets a quota of 0.5 CPU cores for production work', 'a job within the quota is accepted', 'a second job that would exceed it is refused straight away', 'the same job at free priority is accepted'],
  },
  {
    key: 'after', title: 'One job after another', blurb: 'a job that starts only when another job has finished', secs: 20, run: after,
    steps: ['a 10-second batch job starts', 'a second job is told to start after the first: it waits', 'the first finishes and Borg starts the second at once'],
  },
  {
    key: 'overrides', title: 'Tasks of different sizes', blurb: 'one job whose tasks are not all the same size', secs: 10, run: overrides,
    steps: ['a job with 3 tasks starts; task 2 is given more CPU and memory than the others', 'the task list shows each task\'s own limits'],
  },
  {
    key: 'update', title: 'Rolling update and undo', blurb: 'change a running job one task at a time, then undo the change', secs: 20, run: update,
    steps: ['4 copies of a web server start', 'their memory is changed: Borg restarts them one at a time (a rolling update)', 'the change is undone, again one at a time'],
  },
  {
    key: 'drain', title: 'Draining a machine', blurb: 'empty a machine for maintenance without stopping the service', secs: 15, run: drain,
    steps: ['6 copies of a web server start, spread over the machines', 'one machine is drained: its tasks move away one at a time', 'the machine is empty; then it is put back in service'],
  },
  {
    key: 'crash', title: 'A task that crashes on one machine', blurb: 'Borg stops placing a task on the machine it crashes on', secs: 15, run: crash,
    steps: ['one task starts on some machine', 'a broken version is shipped that crashes on exactly that machine', 'it crashes once; Borg remembers the pair and restarts it elsewhere'],
  },
  {
    key: 'fair', title: 'Taking turns', blurb: 'two users at the same priority take turns', secs: 10, run: fair,
    steps: ['two users each ask for more tasks than the cell has room for', 'both jobs start at the same moment', 'Borg places one task per user in turn, so each gets about half'],
  },
  {
    key: 'allocs', title: 'Alloc sets', blurb: 'two jobs share reserved room on a machine, and move together', secs: 30, run: allocs,
    steps: ['an alloc set reserves room on 2 machines', 'a server job and a log saver job start inside it: one task of each per alloc', 'the machine of alloc 0 fails', 'the alloc is reserved on another machine, and both its tasks follow it'],
  },
  {
    key: 'reclaim', title: 'Resource reclamation', blurb: 'batch work runs in room a production job reserved but does not use', secs: 25, run: reclaim,
    steps: ['resource reclamation is turned on', 'a production service asks for most of one machine', 'a batch task fits next to it only once the service\'s reservation has shrunk', 'the service suddenly needs its memory: the machine evicts the batch task', 'reclamation is set back'],
  },
  {
    key: 'failover', title: 'Master failover', blurb: 'kill the elected Borgmaster: another replica takes over at once', secs: 30, run: failover,
    manual: true, offered: (state) => (state?.master?.replicas || []).length >= 2,
    steps: ['a small service starts', 'you kill the elected master in a terminal', 'the other replicas elect a new master', 'no task was restarted: the cell kept running'],
  },
];

// A demo by its name; a unique beginning of the name is enough ("he" -> health).
export function demoByKey(key) {
  const k = String(key || '').toLowerCase();
  if (!k) return null;
  const exact = DEMOS.find((d) => d.key === k);
  if (exact) return exact;
  const pre = DEMOS.filter((d) => d.key.startsWith(k));
  return pre.length === 1 ? pre[0] : null;
}
