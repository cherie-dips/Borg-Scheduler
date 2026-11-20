// Turns the raw /api/state document into what the views draw: job progress, ETAs, health,
// countdowns, groups, per-machine numbers. Pure functions; `now` is server time in seconds.

export const PLACED = new Set(['starting', 'installing', 'running']);
export const TERMINAL = new Set(['finished', 'failed', 'oom', 'killed']);

// Job status -> dashboard group. The server's statuses are finer grained.
export const GROUP = {
  running: 'running', queued: 'queued', waiting: 'queued',
  completed: 'completed', killed: 'completed', failed: 'failed',
};
export const GROUPS = ['running', 'queued', 'completed', 'failed'];

export function emptyCounts() {
  return { waiting: 0, pending: 0, starting: 0, installing: 0, running: 0, finished: 0, failed: 0, oom: 0, killed: 0 };
}

export function jobModel(job, tasks, now) {
  const list = tasks.filter((t) => t.job === job.id).sort((a, b) => a.index - b.index);
  const n = list.length || job.tasks || 1;
  const c = emptyCounts();
  for (const t of list) c[t.state] = (c[t.state] || 0) + 1;

  const d = job.duration || 0; // 0: a service that runs until stopped
  let progress = null, eta = null, doneFrac = 0, failedFrac = 0, runFrac = 0;
  if (d > 0) {
    let maxLeft = 0, allStarted = true;
    for (const t of list) {
      if (t.state === 'finished') doneFrac += 1;
      else if (TERMINAL.has(t.state)) failedFrac += 1;
      else if (t.state === 'running' && t.started) {
        const ran = Math.max(0, now - t.started);
        runFrac += Math.min(1, ran / d);
        maxLeft = Math.max(maxLeft, d - ran);
      } else allStarted = false;
    }
    [doneFrac, failedFrac, runFrac] = [doneFrac / n, failedFrac / n, runFrac / n];
    progress = Math.min(1, doneFrac + failedFrac + runFrac);
    eta = allStarted && c.running > 0 ? Math.max(0, maxLeft) : null;
  }

  const live = list.filter((t) => !TERMINAL.has(t.state));
  const releases = list.map((t) => t.release).filter((r) => r > 0);
  const startsIn = job.status === 'waiting' && releases.length ? Math.max(0, Math.min(...releases) - now) : null;
  const pending = list.find((t) => t.state === 'pending');
  const failedTask = list.find((t) => t.state === 'failed' || t.state === 'oom');

  return {
    ...job,
    taskList: list,
    n,
    c,
    live: live.length,
    up: c.running,
    group: GROUP[job.status] || 'queued',
    progress,          // 0..1 for jobs with an end, null for services
    doneFrac, failedFrac, runFrac,
    eta,               // seconds until the last running task ends (once all have started)
    startsIn,          // seconds until a delayed job starts
    uptime: job.started_at && !job.done ? now - job.started_at : null,
    elapsed: job.done && job.finished_at && job.started_at ? job.finished_at - job.started_at : null,
    reason: failedTask?.reason || pending?.reason || '',
    restarts: list.reduce((s, t) => s + t.restarts, 0),
    preemptions: list.reduce((s, t) => s + t.preemptions, 0),
  };
}

export function taskProgress(task, duration, now) {
  if (task.state === 'finished') return 1;
  if (!(duration > 0) || task.state !== 'running' || !task.started) return null;
  return Math.min(1, Math.max(0, (now - task.started) / duration));
}

export function machineModel(m, tasksById) {
  const cap = m.capacity, alloc = m.allocated, prod = m.allocated_prod, use = m.usage;
  const frac = (a, b) => (b > 0 ? Math.min(1, a / b) : 0);
  return {
    ...m,
    up: m.status === 'up',
    taskList: m.tasks.map((id) => tasksById.get(id)).filter(Boolean)
      .sort((a, b) => b.priority - a.priority || a.job - b.job || a.index - b.index),
    cpu: { prod: frac(prod.cpu, cap.cpu), nonprod: frac(alloc.cpu - prod.cpu, cap.cpu), used: frac(use.cpu, cap.cpu) },
    ram: { prod: frac(prod.ram, cap.ram), nonprod: frac(alloc.ram - prod.ram, cap.ram), used: frac(use.ram, cap.ram) },
  };
}

export function derive(state, now) {
  const tasksById = new Map(state.tasks.map((t) => [t.id, t]));
  const jobs = state.jobs.map((j) => jobModel(j, state.tasks, now))
    .sort((a, b) => (GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group)) || b.priority - a.priority || b.id - a.id);
  const machines = state.machines.map((m) => machineModel(m, tasksById))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const groups = Object.fromEntries(GROUPS.map((g) => [g, jobs.filter((j) => j.group === g)]));
  const tc = { ...emptyCounts(), ...(state.task_counts || {}) };
  return {
    raw: state,
    now,
    jobs,
    machines,
    groups,
    tasksById,
    jobsById: new Map(jobs.map((j) => [j.id, j])),
    counts: {
      machinesUp: machines.filter((m) => m.up).length,
      machines: machines.length,
      running: tc.running + tc.installing + tc.starting,
      queued: tc.pending + tc.waiting,
      done: tc.finished,
      failed: tc.failed + tc.oom,
      killed: tc.killed,
    },
  };
}

// Status changes worth telling the user about, between two derived snapshots.
export function transitions(prev, next) {
  if (!prev) return [];
  const out = [];
  for (const j of next.jobs) {
    const before = prev.jobsById.get(j.id);
    if (!before || before.status === j.status) continue;
    if (j.status === 'completed') out.push({ level: 'ok', text: `${j.name} completed${j.elapsed ? ` in ${Math.round(j.elapsed)}s` : ''}` });
    else if (j.status === 'failed') out.push({ level: 'err', text: `${j.name} failed: ${j.reason || 'a task failed'}` });
    else if (j.status === 'running' && (before.status === 'queued' || before.status === 'waiting'))
      out.push({ level: 'info', text: `${j.name} is running` });
  }
  const prevM = new Map(prev.machines.map((m) => [m.id, m]));
  for (const m of next.machines) {
    const b = prevM.get(m.id);
    if (b && b.status !== m.status)
      out.push(m.up ? { level: 'ok', text: `${m.name} is back up` } : { level: 'err', text: `${m.name} is DOWN; its tasks are being rescheduled` });
  }
  return out;
}
