// Turns the raw /api/state document into what the page draws: the machines with the tasks on
// them, and plain words for priority bands and for how a job is doing. Pure functions (no DOM).

export const PLACED = new Set(['starting', 'installing', 'running']);

// Priority bands, highest first. `cls` is the name of the band's colour in the stylesheet.
export const BANDS = {
  monitoring: { label: 'Monitoring', cls: 'mon' },
  production: { label: 'Production', cls: 'prod' },
  batch: { label: 'Batch', cls: 'batch' },
  free: { label: 'Free', cls: 'free' },
};
export const bandClass = (band) => BANDS[band]?.cls || 'free';

const machineStatus = (m) => (m.status !== 'up' ? 'down' : m.drain === 'draining' ? 'draining' : m.drain === 'drained' ? 'drained' : 'up');

function machineView(m, tasksById) {
  const here = (m.tasks || []).map((id) => tasksById.get(id)).filter(Boolean);
  const ids = new Set(here.map((t) => t.id));
  const order = (a, b) => b.priority - a.priority || a.job - b.job || a.index - b.index;
  // Tasks that run inside an alloc are drawn inside it, not next to it.
  const top = here.filter((t) => !(t.alloc && ids.has(t.alloc))).sort(order);
  return {
    ...m,
    up: m.status === 'up',
    state: machineStatus(m),
    count: here.filter((t) => t.type !== 'alloc').length,
    groups: top.map((t) => ({ task: t, inside: t.type === 'alloc' ? here.filter((x) => x.alloc === t.id).sort(order) : [] })),
    cpu: { cap: m.capacity?.cpu || 0, asked: m.allocated?.cpu || 0 },
    ram: { cap: m.capacity?.ram || 0, asked: m.allocated?.ram || 0 },
  };
}

export function derive(state) {
  const tasks = state.tasks || [];
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const machines = (state.machines || []).map((m) => machineView(m, tasksById))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const real = tasks.filter((t) => t.type !== 'alloc');
  return {
    raw: state,
    now: state.time,
    machines,
    machinesUp: machines.filter((m) => m.up).length,
    running: real.filter((t) => PLACED.has(t.state)).length,
    waiting: real.filter((t) => t.state === 'pending').length,
    // Tasks that are on no machine: waiting, pending, or ended.
    unplaced: tasks.filter((t) => !PLACED.has(t.state)).sort((a, b) => a.job - b.job || a.index - b.index),
  };
}

// Why a task is still waiting for a machine, in plain words.
export function whyWaiting(reason) {
  const r = String(reason || '').replace(/^waiting:\s*/, '');
  if (/satisfies the constraints/.test(r)) return 'no machine is big enough for it';
  if (/no machine has enough free/.test(r)) return 'no machine has enough free room at this priority';
  return r;
}

// How a job is doing: "3 of 3 running" · "all 4 waiting for a machine" · "2 of 3 running, 1 waiting"
export function jobStatus(j) {
  if (j.done) return j.status === 'completed' ? 'finished' : j.status === 'killed' ? 'stopped' : 'failed';
  const c = j.counts || {};
  const running = (c.running || 0) + (c.starting || 0) + (c.installing || 0);
  const pending = c.pending || 0, held = c.waiting || 0;
  if (held && !running && !pending) return j.after ? `starts after ${j.after}` : 'not started yet';
  if (pending && !running) return j.tasks === 1 ? 'waiting for a machine' : `all ${j.tasks} waiting for a machine`;
  return `${running} of ${j.tasks} running${pending ? `, ${pending} waiting` : ''}${held ? `, ${held} not started yet` : ''}`;
}
