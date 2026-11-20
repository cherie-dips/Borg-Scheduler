// Unit tests for the UI's pure modules:  node --test tests/ui
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bar, clock, dur, esc, fit, num, segments, spark, spinner } from '../../ui/js/lib/format.js';
import { distance, didYouMean, rank, score } from '../../ui/js/lib/fuzzy.js';
import {
  parseBool, parseDuration, parseNumber, parsePriority, parseSize, parseWhen, splitArgs, tokenize,
} from '../../ui/js/lib/parse.js';

test('num drops trailing zeros', () => {
  assert.equal(num(0.5), '0.5');
  assert.equal(num(0.25), '0.25');
  assert.equal(num(2), '2');
  assert.equal(num(100, 0), '100');
  assert.equal(num(-0.001), '0');
  assert.equal(num(null), '—');
});

test('dur formats durations', () => {
  assert.equal(dur(42), '42s');
  assert.equal(dur(187), '3m 07s');
  assert.equal(dur(3725), '1h 02m');
  assert.equal(dur(undefined), '—');
});

test('clock is zero padded', () => {
  assert.match(clock(1_700_000_000), /^\d\d:\d\d:\d\d$/);
  assert.equal(clock(0), '—');
});

test('bar has exact width and eighth precision', () => {
  for (const f of [0, 0.01, 0.33, 0.5, 0.999, 1, 1.5, -1, NaN]) assert.equal([...bar(f, 10)].length, 10);
  assert.equal(bar(1, 4), '████');
  assert.equal(bar(0, 4), '░░░░');
  assert.equal(bar(0.5, 4), '██░░');
  assert.equal(bar(0.0625, 2), '▏░');
});

test('segments always fill exactly the width', () => {
  const r = segments([{ frac: 0.3, cls: 'a' }, { frac: 0.3, cls: 'b' }], 10);
  assert.equal(r.parts[0].cells + r.parts[1].cells + r.rest, 10);
  const over = segments([{ frac: 0.8, cls: 'a' }, { frac: 0.8, cls: 'b' }], 10);
  assert.equal(over.parts[0].cells + over.parts[1].cells + over.rest, 10);
});

test('spark scales and pads', () => {
  assert.equal(spark([0, 1], 4, 1), '  ▁█');
  assert.equal([...spark([1, 2, 3, 4, 5, 6, 7, 8, 9], 5)].length, 5);
});

test('spinner cycles over four quadrant glyphs', () => {
  assert.equal(spinner(0), spinner(4));
  assert.notEqual(spinner(0), spinner(1));
  assert.equal(spinner(-1), spinner(3));
});

test('fit pads or cuts with an ellipsis', () => {
  assert.equal(fit('abc', 5), 'abc  ');
  assert.equal(fit('abcdef', 4), 'abc…');
});

test('esc escapes html', () => {
  assert.equal(esc('<b a="1">&</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&lt;/b&gt;');
});

test('tokenize keeps quotes and positions', () => {
  const t = tokenize('schedule "my job" cpu=0.5');
  assert.deepEqual(t.map((x) => x.text), ['schedule', 'my job', 'cpu=0.5']);
  assert.equal(t[2].start, 18);
});

test('splitArgs separates positional, options and flags', () => {
  const { positional, options, flags } = splitArgs(tokenize('web cpu=0.5 RAM=1g -y --force'));
  assert.deepEqual(positional, ['web']);
  assert.deepEqual(options, { cpu: '0.5', ram: '1g' });
  assert.ok(flags.has('y') && flags.has('force'));
});

test('parseDuration', () => {
  assert.equal(parseDuration('90').value, 90);
  assert.equal(parseDuration('5m').value, 300);
  assert.equal(parseDuration('1h30m').value, 5400);
  assert.equal(parseDuration('2 min').value, 120);
  assert.ok(parseDuration('soon').error);
  assert.ok(parseDuration('5m later').error);
});

test('parseWhen understands now, in N, and clock times', () => {
  const now = new Date(2026, 0, 1, 10, 0, 0);
  assert.equal(parseWhen('now', now).value, 0);
  assert.equal(parseWhen('', now).value, 0);
  assert.equal(parseWhen('in 5m', now).value, 300);
  assert.equal(parseWhen(['in', '30s'], now).value, 30);
  assert.equal(parseWhen('+90', now).value, 90);
  assert.equal(parseWhen('at 10:30', now).value, 1800);
  assert.equal(parseWhen('09:00', now).value, 23 * 3600); // already passed today: tomorrow
  assert.ok(parseWhen('at 25:00', now).error);
  assert.ok(parseWhen('later', now).error);
});

test('parsePriority accepts numbers and band names', () => {
  assert.equal(parsePriority('prod').value, 200);
  assert.equal(parsePriority('Monitoring').value, 300);
  assert.equal(parsePriority('150').value, 150);
  assert.ok(parsePriority('1000').error);
  assert.ok(parsePriority('high').error);
});

test('parseSize', () => {
  assert.equal(parseSize('128').value, 128);
  assert.equal(parseSize('1g').value, 1024);
  assert.equal(parseSize('256MB').value, 256);
  assert.ok(parseSize('lots').error);
});

test('parseNumber and parseBool', () => {
  assert.equal(parseNumber('3', { min: 1, max: 5, integer: true }).value, 3);
  assert.ok(parseNumber('3.5', { integer: true }).error);
  assert.ok(parseNumber('9', { max: 5 }).error);
  assert.equal(parseBool('yes').value, true);
  assert.equal(parseBool('off').value, false);
  assert.ok(parseBool('maybe').error);
});

test('fuzzy score prefers prefixes and word starts', () => {
  assert.ok(score('sch', 'schedule') > score('sch', 'reschedule'));
  assert.ok(score('rs', 'reschedule') > 0);
  assert.equal(score('zz', 'schedule'), -1);
});

test('rank orders and filters, honouring aliases', () => {
  const items = [{ name: 'schedule', aliases: ['new'] }, { name: 'reschedule' }, { name: 'machines' }];
  assert.deepEqual(rank('sch', items, (x) => x.name).map((x) => x.name), ['schedule', 'reschedule']);
  assert.equal(rank('new', items, (x) => x.name)[0].name, 'schedule');
});

test('didYouMean catches typos only', () => {
  assert.equal(distance('kitten', 'sitting'), 3);
  assert.equal(didYouMean('scheule', ['schedule', 'help']), 'schedule');
  assert.equal(didYouMean('xyz', ['schedule', 'help']), null);
});
