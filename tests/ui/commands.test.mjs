// The console's command language (ui/js/core/commands.js):  node --test tests/ui/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMMANDS, findMachine, freeName, parse } from '../../ui/js/core/commands.js';

test('run fills in the defaults: one production task of ann', () => {
  assert.deepEqual(parse('run web'), { cmd: 'run', spec: { name: 'web', user: 'ann', tasks: 1, cpu: 0.25, mem: 128, band: 'production', priority: 200, secs: null, spread: false } });
});

test('run takes its options in any order, with a space or "="', () => {
  const { spec } = parse('  run  --tasks 3 web --cpu=0.5 --mem 64 --spread --user bob ');
  assert.deepEqual(spec, { name: 'web', user: 'bob', tasks: 3, cpu: 0.5, mem: 64, band: 'production', priority: 200, secs: null, spread: true });
});

test('a job that ends by itself is batch work unless it names a band', () => {
  assert.deepEqual([parse('run crunch --secs 60').spec.band, parse('run crunch --secs 60').spec.secs], ['batch', 60]);
  assert.equal(parse('run crunch --secs 60 --prio free').spec.priority, 0);
  assert.equal(parse('run probe --prio mon').spec.priority, 300);
});

test('run says in words what is wrong', () => {
  assert.match(parse('run').error, /give the job a name/);
  assert.match(parse('run a b').error, /one name/);
  assert.match(parse('run web --tasks 0').error, /--tasks must be a whole number from 1 to 40/);
  assert.match(parse('run web --cpu lots').error, /--cpu must be more than 0/);
  assert.match(parse('run web --mem 1.5').error, /--mem must be a whole number/);
  assert.match(parse('run web --prio vip').error, /--prio must be prod, batch, free or mon/);
  assert.match(parse('run web --colour red').error, /no option --colour/);
  assert.match(parse('run web --tasks').error, /--tasks needs a value/);
  assert.match(parse('run we/b').error, /job name is made of/);
});

test('machines, quotas and settings', () => {
  assert.deepEqual(parse('drain borglet-2'), { cmd: 'drain', machine: 'borglet-2' });
  assert.deepEqual(parse('UNDRAIN m2'), { cmd: 'undrain', machine: 'm2' });
  assert.deepEqual(parse('fail 3'), { cmd: 'fail', machine: '3', seconds: 30 });
  assert.deepEqual(parse('fail 3 20'), { cmd: 'fail', machine: '3', seconds: 20 });
  assert.match(parse('fail 3 1').error, /5 to 300 seconds/);
  assert.deepEqual(parse('quota'), { cmd: 'quota' });
  assert.deepEqual(parse('quota ann prod 0.5'), { cmd: 'quota', user: 'ann', band: 'production', cpu: 0.5 });
  assert.deepEqual(parse('quota ann batch off'), { cmd: 'quota', user: 'ann', band: 'batch', remove: true });
  assert.match(parse('quota ann free 1').error, /free priority never counts/);
  assert.match(parse('quota ann prod much').error, /number of CPU cores/);
  assert.deepEqual(parse('policy worst-fit'), { cmd: 'policy', policy: 'worst_fit' });
  assert.deepEqual(parse('policy best'), { cmd: 'policy', policy: 'best_fit' });
  assert.match(parse('policy random').error, /policy hybrid/);
  assert.deepEqual(parse('reclaim on'), { cmd: 'reclaim', on: true });
  assert.match(parse('reclaim maybe').error, /reclaim on/);
});

test('the small commands, and what is not a command', () => {
  assert.deepEqual(parse(''), { cmd: '' });
  assert.deepEqual(parse('jobs'), { cmd: 'jobs' });
  assert.deepEqual(parse('rm web'), { cmd: 'rm', name: 'web' });
  assert.deepEqual(parse('rm all'), { cmd: 'rm', name: 'all' });
  assert.deepEqual(parse('help run'), { cmd: 'help', topic: 'run' });
  assert.match(parse('jobs now').error, /takes nothing after it/);
  assert.match(parse('sudo rm').error, /no command "sudo"/);
});

test('help lists every command the parser knows, in lines that fit the console', () => {
  for (const [name, usage, what] of COMMANDS) {
    assert.ok(!/no command/.test(parse(name).error || ''), name);
    assert.ok(usage.length <= 32 && what.length <= 26, usage);
  }
});

test('findMachine accepts a full name or just the number', () => {
  const machines = [{ name: 'borglet-1' }, { name: 'borglet-2' }, { name: 'borglet-12' }];
  assert.equal(findMachine('borglet-2', machines).name, 'borglet-2');
  assert.equal(findMachine('2', machines).name, 'borglet-2');
  assert.equal(findMachine('m12', machines).name, 'borglet-12');
  assert.equal(findMachine('borglet', machines), null);  // more than one
  assert.equal(findMachine('9', machines), null);
});

test('freeName picks a name no job has', () => {
  assert.equal(freeName('web', new Set()), 'web');
  assert.equal(freeName('web', new Set(['web', 'web-2'])), 'web-3');
});
