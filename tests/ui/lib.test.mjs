// Unit tests for the page's pure helpers (formatting, and the words for how a job is doing):
//   node --test tests/ui/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { derive, jobStatus, whyWaiting } from '../../ui/js/core/model.js';
import { capital, clamp, clock, esc, num, plural, sentence } from '../../ui/js/lib/format.js';

test('num drops trailing zeros', () => {
  assert.equal(num(0.5), '0.5');
  assert.equal(num(0.25), '0.25');
  assert.equal(num(2), '2');
  assert.equal(num(100, 0), '100');
  assert.equal(num(-0.001), '0');
  assert.equal(num(null), '—');
});

test('clock is zero padded; clamp keeps a number in range', () => {
  assert.match(clock(1_700_000_000), /^\d\d:\d\d:\d\d$/);
  assert.equal(clock(0), '—');
  assert.equal(clamp(50, 4, 40), 40);
  assert.equal(clamp(1, 4, 40), 4);
});

test('plural, capital and sentence', () => {
  assert.equal(plural(1, 'task'), '1 task');
  assert.equal(plural(3, 'task'), '3 tasks');
  assert.equal(capital('web'), 'Web');
  assert.equal(sentence('no such job'), 'No such job.');
  assert.equal(sentence('Done!'), 'Done!');
});

test('esc escapes html', () => {
  assert.equal(esc('<b a="1">&</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&lt;/b&gt;');
});

test('jobStatus says how a job is doing in a few words', () => {
  assert.equal(jobStatus({ tasks: 3, counts: { running: 2, starting: 1 } }), '3 of 3 running');
  assert.equal(jobStatus({ tasks: 3, counts: { running: 2, pending: 1 } }), '2 of 3 running, 1 waiting');
  assert.equal(jobStatus({ tasks: 4, counts: { pending: 4 } }), 'all 4 waiting for a machine');
  assert.equal(jobStatus({ tasks: 1, counts: { pending: 1 } }), 'waiting for a machine');
  assert.equal(jobStatus({ tasks: 2, counts: { waiting: 2 }, after: 'first' }), 'starts after first');
  assert.equal(jobStatus({ done: true, status: 'completed' }), 'finished');
  assert.equal(jobStatus({ done: true, status: 'killed' }), 'stopped');
});

test('whyWaiting turns the scheduler\'s reason into plain words', () => {
  assert.equal(whyWaiting('waiting: no machine satisfies the constraints / size'), 'no machine is big enough for it');
  assert.equal(whyWaiting('no machine has enough free resources'), 'no machine has enough free room at this priority');
  assert.equal(whyWaiting('preempted by web/0 on borglet-4'), 'preempted by web/0 on borglet-4');
});

test('derive puts tasks on their machines and counts what runs and what waits', () => {
  const m = derive({
    time: 5,
    machines: [{ id: 1, name: 'borglet-2', status: 'up', drain: 'draining', tasks: [11, 12], capacity: { cpu: 2, ram: 1024 }, allocated: { cpu: 1.5, ram: 300 } },
      { id: 0, name: 'borglet-1', status: 'down', drain: '', tasks: [] }],
    tasks: [{ id: 11, job: 1, index: 0, priority: 100, state: 'running', band: 'batch' }, { id: 12, job: 2, index: 0, priority: 200, state: 'starting', band: 'production' },
      { id: 13, job: 2, index: 1, priority: 200, state: 'pending', band: 'production' }],
  });
  assert.deepEqual(m.machines.map((x) => [x.name, x.state, x.count]), [['borglet-1', 'down', 0], ['borglet-2', 'draining', 2]]);
  assert.deepEqual(m.machines[1].groups.map((g) => g.task.id), [12, 11]); // highest priority first
  assert.deepEqual([m.machinesUp, m.running, m.waiting], [1, 2, 1]);
  assert.deepEqual(m.unplaced.map((t) => t.id), [13]);
});
