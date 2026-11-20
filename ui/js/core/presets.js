// Job templates: one keystroke from an empty cell to something interesting.

export const PRESETS = [
  {
    key: 'web', label: 'web frontend', blurb: 'prod service, 3 tasks on 3 different machines',
    spec: { name: 'web-frontend', type: 'service', priority: 200, tasks: 3, cpu: 0.25, ram_mb: 128,
      workload: { type: 'service' }, distinct: true },
  },
  {
    key: 'analytics', label: 'batch analytics', blurb: '8 CPU-bound batch tasks, 2 minutes each',
    spec: { name: 'analytics', type: 'batch', priority: 100, tasks: 8, cpu: 0.3, ram_mb: 96,
      workload: { type: 'cpu', threads: 1, duration: 120 } },
  },
  {
    key: 'crawler', label: 'free-tier crawler', blurb: 'lowest priority: the first to be preempted',
    spec: { name: 'crawler', type: 'batch', priority: 0, tasks: 6, cpu: 0.2, ram_mb: 64,
      workload: { type: 'sleep', duration: 180 } },
  },
  {
    key: 'payments', label: 'big prod job', blurb: 'priority 250: preempts batch work in a full cell',
    spec: { name: 'payments', type: 'service', priority: 250, tasks: 4, cpu: 0.6, ram_mb: 256,
      workload: { type: 'service' }, distinct: true },
  },
  {
    key: 'db', label: 'ssd database', blurb: 'hard constraint: only machines with ssd=true',
    spec: { name: 'db', type: 'service', priority: 220, tasks: 2, cpu: 0.3, ram_mb: 200,
      workload: { type: 'service' }, distinct: true, constraints: [{ key: 'ssd', value: 'true', hard: true }] },
  },
  {
    key: 'memhog', label: 'memory hog', blurb: 'grows to 200 MB under a 64 MB limit: OOM-killed',
    spec: { name: 'mem-hog', type: 'batch', priority: 100, tasks: 1, cpu: 0.2, ram_mb: 64,
      workload: { type: 'mem', mb: 200, duration: 60 } },
  },
  {
    key: 'flaky', label: 'crashing service', blurb: 'exits after 8 s; Borg restarts it with backoff',
    spec: { name: 'flaky', type: 'service', priority: 200, tasks: 1, cpu: 0.1, ram_mb: 48,
      workload: { type: 'crash', duration: 8 } },
  },
  {
    key: 'monitor', label: 'monitoring agent', blurb: 'priority 300, one small task per machine',
    spec: { name: 'monitor', type: 'service', priority: 300, tasks: 5, cpu: 0.05, ram_mb: 32,
      workload: { type: 'service' }, distinct: true },
  },
];

export const BLANK = {
  name: '', user: 'you', type: 'batch', priority: 100, tasks: 1, cpu: 0.25, ram_mb: 64,
  workload: { type: 'sleep', duration: 60 }, distinct: false, constraints: [],
};

export const presetByKey = (key) => PRESETS.find((p) => p.key === key || p.spec.name === key);

// "crawler" -> "crawler-2" when "crawler" is taken (job names must be unique).
export function uniqueName(base, taken) {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base}-${i}`)) return `${base}-${i}`;
}

export const clone = (spec) => JSON.parse(JSON.stringify(spec));
