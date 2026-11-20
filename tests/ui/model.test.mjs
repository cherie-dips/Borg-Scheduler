import assert from 'node:assert/strict';
import { test } from 'node:test';

import { derive, jobModel, taskProgress, transitions } from '../../ui/js/core/model.js';

const job = (over = {}) => ({
  id: 1, name: 'analytics', status: 'running', tasks: 2, duration: 100, priority: 100,
  started_at: 1000, finished_at: 0, done: false, ...over,
});
const task = (over = {}) => ({
  id: 10, job: 1, index: 0, state: 'running', started: 1000, release: 0, restarts: 0, preemptions: 0, reason: '', ...over,
});

test('batch progress interpolates running tasks and counts finished ones', () => {
  const m = jobModel(job(), [task({ started: 1000 }), task({ id: 11, index: 1, state: 'finished' })], 1050);
  assert.equal(m.progress, (0.5 + 1) / 2);
  assert.equal(m.doneFrac, 0.5);
  assert.equal(m.runFrac, 0.25);
  assert.equal(m.eta, 50);
});

test('no ETA until every task has started', () => {
  const m = jobModel(job(), [task(), task({ id: 11, index: 1, state: 'pending', started: 0, reason: 'waiting: no machine' })], 1010);
  assert.equal(m.eta, null);
  assert.equal(m.reason, 'waiting: no machine');
});

test('services have no progress, but report uptime and health', () => {
  const m = jobModel(job({ duration: 0 }), [task()], 1300);
  assert.equal(m.progress, null);
  assert.equal(m.up, 1);
  assert.equal(m.uptime, 300);
});

test('delayed jobs count down to their first release', () => {
  const m = jobModel(job({ status: 'waiting' }), [task({ state: 'waiting', started: 0, release: 1100 })], 1040);
  assert.equal(m.startsIn, 60);
  assert.equal(m.group, 'queued');
});

test('failed tasks count as done but separately, and surface their reason', () => {
  const m = jobModel(job({ status: 'failed', done: true }), [task({ state: 'oom', reason: 'OOM-killed' }), task({ id: 11, index: 1, state: 'finished' })], 2000);
  assert.equal(m.failedFrac, 0.5);
  assert.equal(m.progress, 1);
  assert.equal(m.reason, 'OOM-killed');
  assert.equal(m.group, 'failed');
});

test('taskProgress', () => {
  assert.equal(taskProgress(task(), 100, 1025), 0.25);
  assert.equal(taskProgress(task({ state: 'finished' }), 100, 0), 1);
  assert.equal(taskProgress(task(), 0, 1025), null);
  assert.equal(taskProgress(task({ state: 'pending' }), 100, 1025), null);
});

const state = (jobStatus, machineStatus = 'up') => ({
  time: 0, policy: 'hybrid', task_counts: { running: 1 },
  machines: [{ id: 0, name: 'b1', status: machineStatus, tasks: [10], capacity: { cpu: 1, ram: 512 },
    allocated: { cpu: 0.5, ram: 64 }, allocated_prod: { cpu: 0, ram: 0 }, usage: { cpu: 0.4, ram: 30 } }],
  jobs: [job({ status: jobStatus, done: jobStatus === 'completed', finished_at: 1100 })],
  tasks: [task()],
});

test('derive groups jobs and resolves machine tasks', () => {
  const d = derive(state('running'), 1050);
  assert.equal(d.groups.running.length, 1);
  assert.equal(d.machines[0].taskList[0].id, 10);
  assert.equal(d.machines[0].cpu.nonprod, 0.5);
  assert.equal(d.counts.machinesUp, 1);
});

test('transitions report completions and machine failures once', () => {
  const a = derive(state('running'), 1050);
  const b = derive(state('completed', 'down'), 1100);
  const t = transitions(a, b);
  assert.ok(t.some((x) => x.level === 'ok' && x.text.startsWith('analytics completed')));
  assert.ok(t.some((x) => x.level === 'err' && x.text.includes('DOWN')));
  assert.deepEqual(transitions(b, b), []);
  assert.deepEqual(transitions(null, b), []);
});
