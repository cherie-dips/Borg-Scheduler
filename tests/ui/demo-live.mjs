#!/usr/bin/env node
// Runs the guided demos against a live cell, without a browser: the same scripts the DEMOS tab
// of the page runs (ui/js/core/demos.js), narrated to the terminal.
//
//   node tests/ui/demo-live.mjs [http://localhost:8080] [demo ... | all] [--prefix=demo-] [--keep]
//
// "all" (or no demo named) runs every demo the cell can run: master failover is left out on a
// cell without Borgmaster replicas. Name it to run it anyway.
// Exits 1 if a demo stops early. Jobs are named <prefix>… and removed at the end unless --keep.
// On a cell that other people use, pass a prefix of your own (e.g. --prefix=ui-demo-).

import { makeApi } from '../../ui/js/core/api.js';
import { DEMOS, DemoRunner, describe } from '../../ui/js/core/demos.js';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')).map(([k, v]) => [k, v ?? true]));
const words = args.filter((a) => !a.startsWith('--'));
const base = words.find((w) => /^https?:\/\//.test(w)) || 'http://localhost:8080';
let keys = words.filter((w) => !/^https?:\/\//.test(w));
const everything = !keys.length || keys.includes('all');
if (everything) keys = DEMOS.map((d) => d.key);

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const api = makeApi(base);
if (everything && ((await api.state()).master?.replicas || []).length < 2) {
  keys = keys.filter((k) => k !== 'failover');
  console.log('left out: failover (this cell has one Borgmaster and no replicas; start one with: tools/cell.sh start ha)\n');
}
const runner = new DemoRunner({
  api,
  prefix: typeof flags.prefix === 'string' ? flags.prefix : 'demo-',
  out: { line: (text) => console.log(`${stamp()}  ${text}`) },
});

let failed = 0;
for (const key of keys) {
  const r = await runner.run(key);
  if (!r.ok) failed++;
  console.log('');
}
if (!flags.keep) {
  const left = describe(await runner.clean());
  console.log(left ? `cleaned up: ${left}` : 'nothing left to clean up');
}
console.log(failed ? `FAILED: ${failed} of ${keys.length} demo(s) stopped early` : `PASSED: ${keys.length} demo(s)`);
process.exit(failed ? 1 : 0);
