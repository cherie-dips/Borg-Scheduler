import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyArgs, editEffect, patchOf, specOf, toArgs } from '../../ui/js/cmd/spec.js';
import { BLANK, PRESETS, uniqueName } from '../../ui/js/core/presets.js';

test('applyArgs parses every setting, with aliases', () => {
  const { spec, delay, errors } = applyArgs(BLANK, {
    name: 'web', priority: 'prod', n: '3', cpu: '0.5', mem: '1g', workload: 'cpu', dur: '2m', threads: '2',
    spread: 'yes', need: 'ssd:true', start: '30s',
  });
  assert.deepEqual(errors, []);
  assert.equal(spec.name, 'web');
  assert.equal(spec.priority, 200);
  assert.equal(spec.tasks, 3);
  assert.equal(spec.ram_mb, 1024);
  assert.deepEqual(spec.workload, { type: 'cpu', duration: 120, threads: 2 });
  assert.equal(spec.distinct, true);
  assert.deepEqual(spec.constraints, [{ key: 'ssd', value: 'true', hard: true }]);
  assert.equal(delay, 30);
});

test('applyArgs reports readable errors and suggestions', () => {
  const { errors } = applyArgs(BLANK, { cpus: '1', tasks: '0', prio: 'urgent', need: 'ssd' });
  assert.equal(errors.length, 4);
  assert.match(errors[0], /did you mean cpu=/);
  assert.match(errors[1], /tasks must be between 1 and 200/);
  assert.match(errors[2], /priority/);
  assert.match(errors[3], /key:value/);
});

test('start is refused when editing', () => {
  const { errors } = applyArgs(BLANK, { start: '5m' }, { allowStart: false });
  assert.match(errors[0], /reschedule/);
});

test('dur on a service switches it to a sleep workload; alloc to mem', () => {
  assert.equal(applyArgs({ ...BLANK, workload: { type: 'service' } }, { dur: '10s' }).spec.workload.type, 'sleep');
  assert.deepEqual(applyArgs(BLANK, { alloc: '200' }).spec.workload, { type: 'mem', duration: 60, mb: 200 });
});

test('toArgs round-trips through applyArgs', () => {
  for (const p of PRESETS) {
    const args = Object.fromEntries(toArgs(p.spec).map((a) => a.split(/=(.*)/s).slice(0, 2)));
    const back = applyArgs({ ...BLANK, name: p.spec.name }, args).spec;
    for (const f of ['type', 'priority', 'tasks', 'cpu', 'ram_mb', 'distinct'])
      assert.deepEqual(back[f], p.spec[f] ?? BLANK[f], `${p.key}.${f}`);
    assert.deepEqual(back.workload, p.spec.workload, `${p.key}.workload`);
    assert.deepEqual(back.constraints, p.spec.constraints ?? [], `${p.key}.constraints`);
  }
});

test('toArgs with a base lists only differences', () => {
  const base = PRESETS[0].spec;
  assert.deepEqual(toArgs({ ...base, cpu: 0.5 }, base), ['cpu=0.5']);
  assert.deepEqual(toArgs(base, base), []);
});

test('patchOf and editEffect explain an edit', () => {
  const job = { ...PRESETS[0].spec, id: 1, done: false, live: 3 };
  const spec = specOf(job);
  assert.deepEqual(patchOf(job, spec), {});
  assert.equal(editEffect(job, {}), 'nothing changed');
  assert.match(editEffect(job, patchOf(job, { ...spec, priority: 250 })), /in place/);
  assert.match(editEffect(job, patchOf(job, { ...spec, cpu: 0.5 })), /3 live task\(s\) restart/);
  assert.match(editEffect(job, { tasks: 5 }), /2 task\(s\) added/);
  assert.match(editEffect({ ...job, done: true }, { cpu: 1 }), /next run/);
});

test('uniqueName appends a counter', () => {
  assert.equal(uniqueName('web', []), 'web');
  assert.equal(uniqueName('web', ['web', 'web-2']), 'web-3');
});
