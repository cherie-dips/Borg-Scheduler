// The guided demos (ui/js/core/demos.js): their helpers, and the runner against a small fake cell.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEMOS, DemoRunner, clientNote, demoByKey, describe, fairOrder, fitCount, pickDrainMachine } from '../../ui/js/core/demos.js';

test('there is one demo per feature, each with a plain description and steps', () => {
  assert.deepEqual(DEMOS.map((d) => d.key), ['tour', 'names', 'health', 'quota', 'after', 'overrides', 'update', 'drain', 'crash', 'fair', 'allocs', 'reclaim', 'failover']);
  for (const d of DEMOS) {
    assert.ok(d.title && d.blurb.length > 20 && d.blurb.length < 80, d.key);
    assert.ok(d.steps.length >= 2 && d.secs > 0 && typeof d.run === 'function', d.key);
  }
});

test('demoByKey accepts a name or a unique beginning of one', () => {
  assert.equal(demoByKey('health').key, 'health');
  assert.equal(demoByKey('HE').key, 'health');
  assert.equal(demoByKey('d').key, 'drain');
  assert.equal(demoByKey('fair').key, 'fair');
  assert.equal(demoByKey('f'), null);                 // fair or failover: not unique
  assert.equal(demoByKey('o').key, 'overrides');
  assert.equal(demoByKey('u').key, 'update');
  assert.equal(demoByKey('c').key, 'crash');
  assert.equal(demoByKey(''), null);
  assert.equal(demoByKey('nope'), null);
});

test('failover is only offered in a cell with Borgmaster replicas, and never runs by itself', () => {
  const failover = demoByKey('failover');
  assert.equal(failover.manual, true);
  assert.equal(failover.offered({ master: { replicas: [] } }), false);
  assert.equal(failover.offered({ master: { replicas: [{ name: 'a' }, { name: 'b' }] } }), true);
});

test('clientNote reads the client workload\'s status line', () => {
  assert.deepEqual(clientNote('ok 45 · failed 2 · last: 0.web.ann.cc at 10.0.0.3:20101'), { ok: 45, failed: 2, last: '0.web.ann.cc at 10.0.0.3:20101' });
  assert.equal(clientNote('port 20101 · served 3 request(s)'), null);
  assert.equal(clientNote(''), null);
  assert.equal(clientNote(undefined), null);
});

const machine = (id, cpu, ram, over = {}) => ({ id, name: `borglet-${id + 1}`, status: 'up', drain: '', ip: '10.0.0.' + (id + 1),
  capacity: { cpu, ram }, allocated: { cpu: 0, ram: 0 }, tasks: [], ...over });

test('fitCount counts how many tasks of a size fit into the free room', () => {
  const ms = [machine(0, 1, 512), machine(1, 2, 1024), machine(2, 1, 768)];
  assert.equal(fitCount(ms, 0.6, 32), 1 + 3 + 1);
  assert.equal(fitCount(ms, 0.6, 400), 1 + 2 + 1);                       // memory is the limit
  assert.equal(fitCount([machine(0, 2, 1024, { allocated: { cpu: 1.5, ram: 0 } })], 0.6, 32), 0);
  assert.equal(fitCount([machine(0, 2, 1024, { status: 'down' }), machine(1, 2, 1024, { drain: 'draining' })], 0.6, 32), 0);
  assert.equal(fitCount([], 0.6, 32), 0);
});

test('fairOrder lists who was placed, in order', () => {
  const ev = [
    { kind: 'job', msg: 'submitted demo-fair-ann (9 x 0.60 cpu / 32 MB, priority 0 free, batch), starts in 4s' },
    { kind: 'schedule', msg: 'demo-fair-bob/0 -> borglet-3' },
    { kind: 'schedule', msg: 'demo-fair-ann/0 -> borglet-4, port 20400' },
    { kind: 'schedule', msg: 'other/0 -> borglet-4' },
    { kind: 'task', msg: 'demo-fair-ann/0 running on borglet-4' },
    { kind: 'schedule', msg: 'demo-fair-bob/1 -> borglet-1' },
  ];
  assert.deepEqual(fairOrder(ev, { 'demo-fair-ann': 'ann', 'demo-fair-bob': 'bob' }), ['bob', 'ann', 'bob']);
  assert.deepEqual(fairOrder([], {}), []);
});

test('pickDrainMachine prefers the machine with most of the job, then the least other work', () => {
  const t = (job, m, state = 'running') => ({ job_name: job, machine: m, state });
  const state = {
    machines: [machine(0, 1, 512), machine(1, 1, 512), machine(2, 2, 1024), machine(3, 2, 1024, { drain: 'drained' })],
    tasks: [t('web', 0), t('web', 1), t('web', 1), t('web', 2), t('web', 2), t('other', 1), t('web', 3), t('web', 3), t('web', 3), t('web', 0, 'finished')],
  };
  assert.deepEqual(pickDrainMachine(state, 'web'), { id: 2, name: 'borglet-3', count: 2, others: 0 });
  assert.equal(pickDrainMachine(state, 'nothing'), null);
});

test('describe says what was cleaned up', () => {
  assert.equal(describe({ jobs: 2, quotas: 1, machines: 1 }), '2 jobs, 1 quota, 1 machine put back in service');
  assert.equal(describe({ jobs: 1, quotas: 0, machines: 0 }), '1 job');
  assert.equal(describe({ jobs: 0, quotas: 0, machines: 0 }), '');
});

// ---- the runner, against a tiny cell that starts every task at once --------------------------------

function fakeCell({ never = [] } = {}) {
  const cell = { jobs: [], tasks: [], quotas: [], machines: [machine(0, 2, 1024), machine(1, 2, 1024)], undrained: [] };
  let nextId = 1;
  const refuse = (message, status) => Object.assign(new Error(message), { status });
  const api = {
    async state() {
      return structuredClone({ time: Date.now() / 1000, jobs: cell.jobs, tasks: cell.tasks, machines: cell.machines });
    },
    async submit(spec) {
      const band = spec.priority >= 200 ? 'production' : spec.priority >= 100 ? 'batch' : 'free';
      const q = cell.quotas.find((x) => x.user === spec.user && x.band === band);
      const used = cell.jobs.filter((j) => j.user === spec.user && j.band === band).reduce((s, j) => s + j.tasks * j.cpu, 0);
      if (q && q.cpu != null && used + spec.tasks * spec.cpu > q.cpu + 1e-9) throw refuse(`rejected by admission control: ${spec.name} is over quota`, 403);
      const id = nextId++;
      cell.jobs.push({ id, name: spec.name, user: spec.user, band, tasks: spec.tasks, cpu: spec.cpu, ram_mb: spec.ram_mb, status: 'running', update: {} });
      for (let i = 0; i < spec.tasks; i++) {
        const own = spec.overrides?.[i] || {};
        cell.tasks.push({ job: id, job_name: spec.name, index: i, state: never.includes(spec.name) ? 'pending' : 'running', machine: i % 2, machine_name: `borglet-${(i % 2) + 1}`,
          cpu: own.cpu ?? spec.cpu, ram_mb: own.ram_mb ?? spec.ram_mb, ports: [], restarts: 0, avoid: [] });
      }
      return { id };
    },
    async remove(id) {
      cell.jobs = cell.jobs.filter((j) => j.id !== id);
      cell.tasks = cell.tasks.filter((t) => t.job !== id);
      return { ok: true };
    },
    async quota() {
      return { quotas: structuredClone(cell.quotas) };
    },
    async setQuota(q) {
      cell.quotas = cell.quotas.filter((x) => !(x.user === q.user && x.band === q.band));
      if (!q.remove) cell.quotas.push({ user: q.user, band: q.band, cpu: q.cpu ?? null, ram_mb: q.ram_mb ?? null, disk_mb: q.disk_mb ?? null });
      return { ok: true };
    },
    async undrain(id) {
      cell.machines.find((m) => m.id === id).drain = '';
      cell.undrained.push(id);
      return { ok: true };
    },
  };
  return { cell, api };
}

const runner = (api, extra = {}) => {
  const lines = [], pointed = [], stages = [];
  const r = new DemoRunner({ api, pollMs: 5, pace: 0, out: { line: (text, cls) => lines.push({ text, cls }), point: (kind, id) => pointed.push([kind, id]), stage: (n) => stages.push(n) }, ...extra });
  return { r, lines, pointed, stages };
};

test('the quota demo runs to the end: one line per step, the refusal quoted', async () => {
  const { cell, api } = fakeCell();
  const { r, lines, stages } = runner(api);
  const result = await r.run('quota');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(stages, [1, 2, 3, 4]);             // the outline steps, as the page prints them
  assert.match(result.text, /demo quota finished/);
  assert.match(result.text, /Clean up/);
  const steps = lines.filter((l) => /^\s*\d+ ▸/.test(l.text)).map((l) => l.text);
  assert.equal(steps.length, 5);
  assert.match(steps[0], /^ 1 ▸ Giving user demo-ann a quota/);
  assert.match(steps[3], /Borg refused it at once.*rejected by admission control: demo-quota-big/);
  assert.equal(lines[0].cls, 'hl');
  assert.equal(lines.at(-1).cls, 'ok');
  assert.deepEqual(cell.jobs.map((j) => [j.name, j.band]), [['demo-quota-web', 'production'], ['demo-quota-big', 'free']]);
  assert.equal(r.running, null);
});

test('the overrides demo reports each task\'s own size', async () => {
  const { api } = fakeCell();
  const { r, lines, pointed } = runner(api);
  const result = await r.run('overrides');
  assert.equal(result.ok, true, result.text);
  assert.deepEqual(pointed, [['job', 1]]);            // the page highlights the job the demo is about
  assert.ok(lines.some((l) => l.text.includes('task 0 0.1 cpu · 32 MB, task 1 0.1 cpu · 32 MB, task 2 0.3 cpu · 96 MB')));
});

test('every demo clears what the one before left; a custom prefix names jobs and users', async () => {
  const { cell, api } = fakeCell();
  await api.submit({ name: 'web', user: 'you', priority: 200, tasks: 1, cpu: 0.1, ram_mb: 32 });
  const { r, lines } = runner(api, { prefix: 'ui-demo-' });
  await r.run('quota');
  const again = await r.run('overrides');
  assert.equal(again.ok, true);
  assert.ok(lines.some((l) => l.text.includes('first cleared what an earlier demo left: 2 jobs, 1 quota')));
  assert.deepEqual(cell.jobs.map((j) => j.name), ['web', 'ui-demo-overrides-web']); // other people's jobs are never touched
  assert.deepEqual(cell.quotas, []);
});

test('clean removes only what demos made, and puts back machines a demo drained', async () => {
  const { cell, api } = fakeCell();
  for (const [name, user] of [['demo-x', 'demo'], ['web', 'you'], ['demo-y', 'demo-ann'], ['demonstration', 'you']]) await api.submit({ name, user, priority: 200, tasks: 1, cpu: 0.1, ram_mb: 32 });
  cell.quotas.push({ user: 'demo-ann', band: 'production', cpu: 1 }, { user: 'you', band: 'production', cpu: 1 }, { user: '*', band: 'batch', cpu: 1 });
  cell.machines[0].drain = 'drained';   // drained by a demo that was cut short
  cell.machines[1].drain = 'draining';  // drained by someone else: not ours to undo
  const storage = { names: ['borglet-1', 'gone-machine'], get() { return this.names; }, set(v) { this.names = v; } };
  const { r } = runner(api, { storage });
  assert.deepEqual(await r.clean(), { jobs: 2, quotas: 1, machines: 1 });
  assert.deepEqual(cell.jobs.map((j) => j.name), ['web', 'demonstration']);
  assert.deepEqual(cell.quotas.map((q) => q.user), ['you', '*']);
  assert.deepEqual(cell.undrained, [0]);
  assert.equal(cell.machines[1].drain, 'draining');
  assert.deepEqual(storage.names, []);
  assert.deepEqual(await r.clean(), { jobs: 0, quotas: 0, machines: 0 });
});

test('a demo that cannot go on says why in plain words and how to clean up', async () => {
  const { api } = fakeCell();
  api.setQuota = async () => { throw Object.assign(new Error('prod quota cannot be oversold: the cell has 7.00 cpu and 7.00 is already promised'), { status: 400 }); };
  const { r, lines } = runner(api);
  const result = await r.run('quota');
  assert.equal(result.ok, false);
  assert.match(result.text, /demo quota stopped early: the Borgmaster said: prod quota cannot be oversold/);
  assert.match(result.text, /Clean up/);
  assert.equal(lines.at(-1).cls, 'err');
  assert.equal(r.running, null);
});

test('a demo needs enough machines in service', async () => {
  const { cell, api } = fakeCell();
  cell.machines[1].status = 'down';
  const { r } = runner(api);
  const result = await r.run('drain');
  assert.equal(result.ok, false);
  assert.match(result.text, /needs 2 machines in service, and the cell has 1/);
  assert.deepEqual(cell.jobs, []);
});

test('until gives up with a readable reason; an unknown demo and a second run are refused', async () => {
  const { api } = fakeCell({ never: ['demo-overrides-web'] });
  const { r } = runner(api);
  await assert.rejects(r.until('the moon to rise', () => false, { timeout: 0.05 }), /waited 0\.05 s for the moon to rise, but it did not happen/);
  assert.equal(await r.until('a value', (s) => s.machines.length), 2);
  assert.match((await r.run('nope')).text, /there is no demo called "nope" · demos: tour, names, health/);
  const first = r.run('overrides');           // its tasks never start, so it keeps waiting
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(r.running, 'overrides');
  assert.match((await r.run('quota')).text, /demo overrides is still running/);
  assert.equal(r.stop(), true);               // stop: it ends and removes what it started
  const result = await first;
  assert.equal(result.ok, false);
  assert.match(result.text, /demo overrides stopped · removed 1 job/);
  assert.deepEqual((await api.state()).jobs, []);
  assert.equal(r.stop(), false);
});
