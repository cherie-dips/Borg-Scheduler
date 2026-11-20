import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accept, complete, suggestCommand } from '../../ui/js/cmd/complete.js';
import { findJob, lookup } from '../../ui/js/cmd/registry.js';

const model = {
  jobs: [
    { id: 1, name: 'web-frontend', status: 'running', priority: 200, tasks: 3, done: false },
    { id: 2, name: 'analytics', status: 'completed', priority: 100, tasks: 8, done: true },
    { id: 3, name: 'web-cache', status: 'queued', priority: 200, tasks: 1, done: false },
  ],
  machines: [{ id: 0, name: 'borglet-1', status: 'up', taskList: [], attributes: { ssd: 'true', rack: 'r1' } }],
};
const ctx = { model };

test('empty prompt lists every visible command (palette)', () => {
  const r = complete('', ctx);
  assert.ok(r.items.length > 15);
  assert.ok(!r.items.some((i) => i.value === 'exit'));
});

test('command words complete with ghost text', () => {
  const r = complete('sch', ctx);
  assert.equal(r.items[0].value, 'schedule');
  assert.equal(r.ghost, 'edule');
  assert.equal(accept('sch', r, r.items[0]), 'schedule ');
});

test('job arguments complete from live data', () => {
  const r = complete('edit we', ctx);
  assert.deepEqual(r.items.slice(0, 2).map((i) => i.value).sort(), ['web-cache', 'web-frontend']);
  assert.equal(accept('edit we', r, r.items[0]), `edit ${r.items[0].value} `);
});

test('kill only offers live jobs', () => {
  const r = complete('kill ', ctx);
  assert.deepEqual(r.items.map((i) => i.value).sort(), ['web-cache', 'web-frontend']);
});

test('settings complete as key= then values', () => {
  let r = complete('schedule web pr', ctx);
  assert.ok(r.items.some((i) => i.value === 'prio=' || i.value === 'prefer='));
  r = complete('schedule web prio=pr', ctx);
  assert.equal(r.items[0].value, 'prod');
  assert.equal(r.ghost, 'od');
  assert.equal(accept('schedule web prio=pr', r, r.items[0]), 'schedule web prio=prod ');
  r = complete('schedule web need=', ctx);
  assert.deepEqual(r.items.map((i) => i.value), ['rack:r1', 'ssd:true']);
});

test('settings already used are not offered again; edit never offers start=', () => {
  const r = complete('schedule x cpu=1 ', ctx);
  assert.ok(!r.items.some((i) => i.value === 'cpu='));
  assert.ok(r.items.some((i) => i.value === 'start='));
  assert.ok(!complete('edit web-frontend ', ctx).items.some((i) => i.value === 'start='));
});

test('reschedule offers start times after the job', () => {
  const r = complete('reschedule analytics ', ctx);
  assert.ok(r.items.some((i) => i.value === 'now') && r.items.some((i) => i.value.startsWith('at ')));
});

test('unknown commands get no completions but a suggestion', () => {
  assert.equal(complete('frobnicate x', ctx).items.length, 0);
  assert.equal(suggestCommand('scheduel'), 'schedule');
});

test('findJob resolves exact names, unique prefixes and ids; explains ambiguity', () => {
  assert.equal(findJob(model, 'analytics').value.id, 2);
  assert.equal(findJob(model, 'web-f').value.id, 1);
  assert.equal(findJob(model, '3').value.id, 3);
  assert.match(findJob(model, 'web').error, /matches web-frontend, web-cache/);
  assert.match(findJob(model, 'nope').error, /no job called/);
});

test('aliases resolve', () => {
  assert.equal(lookup('new').name, 'schedule');
  assert.equal(lookup('?').name, 'help');
  assert.equal(lookup('nodes').name, 'machines');
});
