// Job spec <-> command-line settings (key=value). Shared by the `schedule` and `edit` commands
// and by the visual form, which shows the equivalent command while you fill it in.

import { didYouMean } from '../lib/fuzzy.js';
import { BANDS, NAME_RE, parseBool, parseDuration, parseNumber, parsePriority, parseSize, parseWhen } from '../lib/parse.js';
import { num } from '../lib/format.js';

export const KEYS = {
  name: { desc: 'job name: letters, digits, - _ .', hint: 'web' },
  user: { desc: 'owner (used for fair share)', hint: 'alice' },
  type: { desc: 'service restarts on failure; batch runs to the end', values: ['service', 'batch'] },
  prio: { desc: 'priority 0-999 or free | batch | prod | monitoring', values: ['free', 'batch', 'prod', 'monitoring'], aliases: ['priority', 'p'] },
  tasks: { desc: 'number of tasks, 1-200', hint: '3', aliases: ['n', 'count'] },
  cpu: { desc: 'CPU cores per task', hint: '0.25' },
  ram: { desc: 'memory per task in MB (or 1g)', hint: '128', aliases: ['mem', 'ram_mb', 'memory'] },
  work: { desc: 'what each task runs', values: ['service', 'sleep', 'cpu', 'mem', 'crash'], aliases: ['workload'] },
  dur: { desc: 'run time for sleep/cpu/mem/crash, e.g. 2m', hint: '60s', aliases: ['duration', 'for'] },
  threads: { desc: 'busy threads per task (work=cpu)', hint: '1' },
  alloc: { desc: 'MB each task allocates (work=mem)', hint: '200', aliases: ['mb'] },
  spread: { desc: 'at most one task per machine', values: ['yes', 'no'], aliases: ['distinct'] },
  need: { desc: 'hard constraint, e.g. need=ssd:true', hint: 'ssd:true', aliases: ['on', 'where'] },
  prefer: { desc: 'soft constraint, e.g. prefer=rack:r1', hint: 'rack:r1' },
  start: { desc: 'when to start: now, 30s, 5m, 14:30', hint: '30s', aliases: ['at', 'in', 'delay'] },
};

const CANON = {};
for (const [k, v] of Object.entries(KEYS)) for (const n of [k, ...(v.aliases || [])]) CANON[n] = k;
export const canonicalKey = (k) => CANON[String(k).toLowerCase()];

export const WORKLOADS = {
  service: 'long-running server (until stopped)',
  sleep: 'idle for a while, then exit',
  cpu: 'burn CPU (throttled to the limit)',
  mem: 'grow memory (OOM if over the limit)',
  crash: 'exit with an error after a while',
};

function setWorkload(spec, type) {
  const old = spec.workload || {};
  if (type === 'service') spec.workload = { type };
  else {
    spec.workload = { type, duration: old.duration || 60 };
    if (type === 'cpu') spec.workload.threads = old.threads || 1;
    if (type === 'mem') spec.workload.mb = old.mb || 100;
  }
}

function parseConstraint(s, hard) {
  const m = String(s).match(/^([A-Za-z0-9_.-]+)[:=](.+)$/);
  return m ? { value: { key: m[1], value: m[2], hard } } : { error: `"${s}" should look like key:value, e.g. ssd:true` };
}

// Applies key=value `options` on top of `base` (a job spec). Returns the new spec, a start
// delay (seconds, schedule only) and readable errors.
export function applyArgs(base, options, { allowStart = true } = {}) {
  const spec = JSON.parse(JSON.stringify(base));
  spec.workload = spec.workload || { type: 'service' };
  spec.constraints = spec.constraints || [];
  const errors = [];
  let delay = 0;
  const err = (r) => (r.error ? (errors.push(r.error), true) : false);
  let constraintsReset = false;

  for (const [rawKey, raw] of Object.entries(options)) {
    const key = canonicalKey(rawKey);
    if (!key) {
      const guess = didYouMean(rawKey, Object.keys(CANON));
      errors.push(`unknown setting "${rawKey}"${guess ? `: did you mean ${guess}=?` : `; try ${Object.keys(KEYS).join(', ')}`}`);
      continue;
    }
    let r;
    switch (key) {
      case 'name':
        if (!NAME_RE.test(raw)) errors.push(`name "${raw}" must be 1-40 letters, digits, - _ . (no spaces)`);
        else spec.name = raw;
        break;
      case 'user':
        spec.user = raw || 'you';
        break;
      case 'type':
        if (raw === 'service' || raw === 'batch') spec.type = raw;
        else errors.push('type must be service or batch');
        break;
      case 'prio':
        if (!err((r = parsePriority(raw)))) spec.priority = r.value;
        break;
      case 'tasks':
        if (!err((r = parseNumber(raw, { min: 1, max: 200, integer: true, name: 'tasks' })))) spec.tasks = r.value;
        break;
      case 'cpu':
        if (!err((r = parseNumber(raw, { min: 0.01, max: 64, name: 'cpu' })))) spec.cpu = r.value;
        break;
      case 'ram':
        if (!err((r = parseSize(raw)))) spec.ram_mb = r.value;
        break;
      case 'work':
        if (raw in WORKLOADS) setWorkload(spec, raw);
        else errors.push(`work must be one of ${Object.keys(WORKLOADS).join(', ')}`);
        break;
      case 'dur':
        if (!err((r = parseDuration(raw)))) {
          if (spec.workload.type === 'service') setWorkload(spec, 'sleep');
          spec.workload.duration = r.value;
        }
        break;
      case 'threads':
        if (!err((r = parseNumber(raw, { min: 1, max: 16, integer: true, name: 'threads' })))) {
          if (spec.workload.type !== 'cpu') setWorkload(spec, 'cpu');
          spec.workload.threads = r.value;
        }
        break;
      case 'alloc':
        if (!err((r = parseSize(raw)))) {
          if (spec.workload.type !== 'mem') setWorkload(spec, 'mem');
          spec.workload.mb = r.value;
        }
        break;
      case 'spread':
        if (!err((r = parseBool(raw)))) spec.distinct = r.value;
        break;
      case 'need':
      case 'prefer':
        if (!constraintsReset) [spec.constraints, constraintsReset] = [[], true];
        if (raw === '' || raw === 'none') break;
        if (!err((r = parseConstraint(raw, key === 'need')))) spec.constraints.push(r.value);
        break;
      case 'start':
        if (!allowStart) errors.push('to change when a job runs, use: reschedule <job> in 5m');
        else if (!err((r = parseWhen(raw)))) delay = r.value;
        break;
    }
  }
  return { spec, delay, errors };
}

const bandName = (p) => Object.keys(BANDS).find((k) => BANDS[k] === p && k !== 'production' && k !== 'mon');

// The command-line settings that describe `spec`; with `base`, only those that differ.
export function toArgs(spec, base = null) {
  const out = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const add = (cond, s) => cond && out.push(s);
  const diff = (f) => !base || !same(f(spec), f(base));
  add(diff((s) => s.type), `type=${spec.type}`);
  add(diff((s) => s.priority), `prio=${bandName(spec.priority) || spec.priority}`);
  add(diff((s) => s.tasks), `tasks=${spec.tasks}`);
  add(diff((s) => s.cpu), `cpu=${num(spec.cpu)}`);
  add(diff((s) => s.ram_mb), `ram=${spec.ram_mb}`);
  const w = spec.workload || { type: 'service' };
  add(diff((s) => s.workload?.type), `work=${w.type}`);
  if (w.type !== 'service') {
    add(diff((s) => s.workload?.duration), `dur=${w.duration}s`);
    if (w.type === 'cpu') add(diff((s) => s.workload?.threads), `threads=${w.threads}`);
    if (w.type === 'mem') add(diff((s) => s.workload?.mb), `alloc=${w.mb}`);
  }
  add(diff((s) => !!s.distinct), `spread=${spec.distinct ? 'yes' : 'no'}`);
  if (diff((s) => s.constraints || [])) {
    const cs = spec.constraints || [];
    if (!cs.length && base) out.push('need=none'); // only worth saying when removing constraints
    for (const c of cs) out.push(`${c.hard ? 'need' : 'prefer'}=${c.key}:${c.value}`);
  }
  if (spec.user && spec.user !== 'you' && diff((s) => s.user)) out.push(`user=${spec.user}`);
  return out;
}

// Fields to PATCH when editing `job` into `spec` (only what changed).
export function patchOf(job, spec) {
  const fields = ['user', 'type', 'priority', 'tasks', 'cpu', 'ram_mb', 'workload', 'distinct', 'constraints'];
  const norm = (o, f) => (f === 'constraints' ? o[f] || [] : f === 'distinct' ? !!o[f] : o[f] ?? null);
  const patch = {};
  for (const f of fields) if (JSON.stringify(norm(job, f)) !== JSON.stringify(norm(spec, f))) patch[f] = spec[f];
  return patch;
}

// Job document (from /api/state) -> editable spec.
export const specOf = (job) => ({
  name: job.name, user: job.user, type: job.type, priority: job.priority, tasks: job.tasks, cpu: job.cpu,
  ram_mb: job.ram_mb, workload: { ...job.workload }, distinct: job.distinct, constraints: (job.constraints || []).map((c) => ({ ...c })),
});

// Plain-language consequences of an edit, before it is applied.
export function editEffect(job, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return 'nothing changed';
  if (job.done) return 'saved for the next run (reschedule to run it again)';
  const restart = keys.some((k) => ['cpu', 'ram_mb', 'workload', 'distinct', 'constraints'].includes(k));
  const parts = [];
  if (restart) parts.push(`${job.live || job.tasks} live task(s) restart with the new spec`);
  else if (keys.some((k) => k === 'priority' || k === 'user')) parts.push('applies in place, no restarts');
  if ('tasks' in patch) {
    const d = patch.tasks - job.tasks;
    if (d > 0) parts.push(`${d} task(s) added`);
    if (d < 0) parts.push(`${-d} task(s) stopped and removed`);
  }
  if ('type' in patch && parts.length === 0) parts.push('changes the restart policy only');
  return parts.join('; ');
}
