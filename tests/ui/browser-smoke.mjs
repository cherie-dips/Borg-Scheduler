#!/usr/bin/env node
// Quick browser check of the page: drives headless Chrome over the DevTools protocol (no
// dependencies) with real clicks and keystrokes, saves screenshots, and fails on any console error
// or uncaught exception. The window is 1280x720, a small laptop or projector screen: what fits
// there fits a bigger one. It opens each tab (and checks that each fits one screen), runs guided
// demos (and checks that every step keeps what was said under it), and uses the console: typed
// commands and shortcuts for a job, a quota, a machine and a setting.
//
//   node tests/ui/browser-smoke.mjs [http://localhost:8080] [out-dir] [demo ...]     (default: quota tour)
//
// It removes what it made: the demos' jobs (names starting with demo-) and its own job and
// quota (named smoke-…). Set CHROME=/path/to/chrome if Chrome is not found.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:8080';
const OUT = process.argv[3] || 'build/ui-smoke';
const RUN = process.argv.slice(4).length ? process.argv.slice(4) : ['quota', 'tour'];
const SCREEN = { width: 1280, height: 720 };
const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => existsSync(p));
if (!CHROME) {
  console.error('Chrome not found: set CHROME=/path/to/chrome');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Chrome + DevTools protocol ---------------------------------------------------------------
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'mb-smoke-'))}`, `--window-size=${SCREEN.width},${SCREEN.height}`, 'about:blank'], { stdio: 'ignore' });
let targets = [];
for (let i = 0; i < 50 && !targets.find((t) => t.type === 'page'); i++) {
  await sleep(200);
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { /* not up yet */ }
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    return msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    const e = msg.params.entry;
    // The quota demo makes Borg refuse a job on purpose: Chrome logs that 403 answer itself.
    const refusal = e.source === 'network' && /\/api\/jobs$/.test(e.url || '') && /403/.test(e.text);
    if (!refusal && !/favicon/.test(e.url || '')) errors.push(`${e.text} ${e.url || ''}`);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
async function click(selector) {
  const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) throw new Error(`no element ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await sleep(200);
}
let shot = 0;
async function screenshot(name) {
  await sleep(150);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT, `${String(++shot).padStart(2, '0')}-${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`       saved ${file}`);
}
async function until(desc, expr, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(expr)) return true;
    await sleep(200);
  }
  throw new Error(`timed out: ${desc}`);
}
let failures = 0;
async function step(desc, fn) {
  try {
    await fn();
    console.log(`  ok   ${desc}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${desc}: ${e.message}`);
    await screenshot(`FAIL-${desc.replace(/\W+/g, '-').slice(0, 40)}`).catch(() => {});
  }
}
const view = (field) => `(window.miniBorg.demos.view || {}).${field}`;
const state = (expr) => `((s) => ${expr})(window.miniBorg.store.state || {})`;
// Types a line at the console's prompt and presses Enter, once the command before it is done.
async function typeLine(text) {
  await until('the prompt to be free', `!document.getElementById('k-form').classList.contains('busy')`, 20000);
  await click('#k-in');
  await send('Input.insertText', { text });
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined });
  await sleep(200);
}
const printed = (re) => `${re}.test(document.getElementById('k-out').textContent)`;
// Everything is on one screen: the page itself never scrolls, and nothing in a pane is wider than
// the pane (the end of a line would be hidden behind its edge).
async function fitsScreen(where) {
  const [w, h, vw, vh] = await evaluate(`[document.documentElement.scrollWidth, document.documentElement.scrollHeight, innerWidth, innerHeight]`);
  if (w > vw || h > vh) throw new Error(`${where} does not fit the screen: ${w}x${h} in ${vw}x${vh}`);
  const wide = await evaluate(`[...document.querySelectorAll('.pane-b')].filter((p) => p.scrollWidth > p.clientWidth + 1)
    .map((p) => (p.closest('.pane').querySelector('h2') || {}).textContent || 'a pane').join(', ')`);
  if (wide) throw new Error(`${where}: something is wider than its pane (${wide})`);
}

// ---- the check ------------------------------------------------------------------------------------
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { ...SCREEN, deviceScaleFactor: 1, mobile: false });
console.log(`browser check of ${BASE} (screenshots in ${OUT})`);

const LIST = `document.querySelectorAll('#d-list a.dl[data-demo]').length >= 12`;
// What was said in the run on screen, and how much of it the output shows.
const SAID = `window.miniBorg.demos.view.lines.filter((l) => l.kind === 'say').length`;
const SHOWN = `document.querySelectorAll('#d-out .st-say p.say').length`;
const KEPT = `document.getElementById('w-cell').dataset.kept === 'yes'`;

await step('the page loads: heading, four tabs, the demo list, the output and the live cell', async () => {
  await send('Page.navigate', { url: BASE });
  await until('demo list', LIST);
  if ((await evaluate(`document.querySelector('h1').textContent`)) !== 'LIVE BORG CELL') throw new Error('the heading is not LIVE BORG CELL');
  if ((await evaluate(`[...document.querySelectorAll('.tabs a')].map((a) => a.textContent).join(' ')`)) !== 'DEMOS CONSOLE CELL LOG') throw new Error('the tabs are not DEMOS CONSOLE CELL LOG');
  await until('live', `document.querySelector('#status .state.ok') !== null && /MACHINES UP/.test(document.getElementById('status').textContent)`);
  await until('the machines', `document.querySelectorAll('#w-cell .m').length >= 3`);
  await until('the selected demo\'s steps', `document.querySelectorAll('#d-out .st').length >= 2`);
  if (await evaluate(`window.miniBorg.demos.leftovers()`)) {
    await click('#d-actions [data-act="clean"]');
    await until('old demo jobs removed', `window.miniBorg.demos.leftovers() === 0`, 15000);
  }
  await evaluate(`document.getElementById('w-cell').dataset.kept = 'yes'`); // to see that the cell is never rebuilt
  await fitsScreen('DEMOS');
  await screenshot('demos');
});

await step('the CELL and LOG tabs show the machines, the control plane and the event log', async () => {
  await click('.tabs a[data-tab="cell"]');
  await until('the tables', `document.querySelectorAll('#c-machines tbody tr').length >= 3 && document.querySelectorAll('#c-facts dt').length >= 5`);
  await fitsScreen('CELL');
  await screenshot('cell');
  await click('.tabs a[data-tab="log"]');
  await until('the event log', `document.querySelectorAll('#a-rows .ev').length >= 1`);
  await fitsScreen('LOG');
  await screenshot('log');
  await click('.tabs a[data-tab="demos"]');
  await until('back on the demos', LIST);
  await evaluate(`document.getElementById('w-cell').dataset.kept = 'yes'`);
});

for (const key of RUN) {
  const other = key === 'quota' ? 'after' : 'quota';
  await step(`demo ${key}: RUN starts it, the steps fill in, no other demo can start`, async () => {
    await evaluate(`location.hash = '#/demos'`);
    await until('the list', `document.querySelector('a.dl[data-demo="${key}"]') !== null`);
    await click(`a.dl[data-demo="${key}"]`);
    await until('it is selected', `document.querySelector('#d-actions [data-act="run"][data-demo="${key}"]') !== null && document.querySelector('a.dl.on[data-demo="${key}"]') !== null`);
    await click('#d-actions [data-act="run"]');
    await until('running', `${view('status')} === 'running'`);
    await until('a step in progress', `document.querySelector('#d-out .st.now') !== null`, 20000);
    await click(`a.dl[data-demo="${other}"]`);
    await until('another demo', `document.querySelector('#d-actions [data-act="run"][data-demo="${other}"]') !== null`);
    if (!(await evaluate(`document.querySelector('#d-actions [data-act="run"]').disabled`))) throw new Error('another demo could be started');
    await click(`a.dl[data-demo="${key}"]`);
    await until('its tasks are drawn', `document.querySelectorAll('#w-cell .chip:not(.other)').length > 0`, 30000);
    if (!(await evaluate(KEPT))) throw new Error('the live cell was rebuilt when another demo was selected');
    await sleep(2500);
    await fitsScreen('a running demo');
    await screenshot(`${key}-running`);
  });
  if (key === 'tour') {
    await step('demo tour: the cell fills up, then a production job pushes out batch work', async () => {
      await until('step 3', `${view('stage')} >= 3`, 120000);
      await sleep(1500);
      await screenshot('tour-cell-full');
      if (await evaluate(`document.querySelectorAll('#d-out .st.done .st-say p.say').length < 2`)) throw new Error('the finished steps lost their text');
      await until('step 4', `${view('stage')} >= 4`, 60000);
      await sleep(2500);
      await screenshot('tour-preemption');
    });
  }
  await step(`demo ${key}: runs to the end, and every step still shows what was said`, async () => {
    await until('the demo to end', `${view('status')} !== 'running'`, 200000);
    await sleep(1200);
    await screenshot(`${key}-finished`);
    const status = await evaluate(view('status'));
    if (status !== 'ok') throw new Error(`it ended as "${status}": ${await evaluate(view('result'))}`);
    if (await evaluate(`document.querySelectorAll('#d-out .st.done').length !== document.querySelectorAll('#d-out .st').length`)) throw new Error('not every step is ticked');
    const [said, shown] = [await evaluate(SAID), await evaluate(SHOWN)];
    if (!said || said !== shown) throw new Error(`the demo said ${said} things, the output shows ${shown}`);
    if (!(await evaluate(`document.querySelector('#d-out .result.ok') !== null`))) throw new Error('no result at the end of the output');
  });
  await step(`demo ${key}: CLEAN UP removes its jobs; its output stays readable`, async () => {
    await click('#d-actions [data-act="clean"]');
    await until('jobs removed', `window.miniBorg.demos.leftovers() === 0`, 20000);
    await sleep(400);
    if (await evaluate(`${SAID} !== ${SHOWN}`)) throw new Error('the output lost its text after CLEAN UP');
  });
}

// ---- the console: everything it makes is named smoke-… and removed again --------------------------
const mine = (expr) => state(`(s.jobs || []).filter((j) => j.name.startsWith('smoke-'))${expr}`);

await step('console: a typed command starts a job, and its tasks are placed on machines', async () => {
  await click('.tabs a[data-tab="console"]');
  await until('the prompt and the shortcuts', `document.getElementById('k-in') !== null && document.querySelectorAll('#k-keys [data-act="type"]').length >= 8`);
  if (!(await evaluate(KEPT))) throw new Error('the live cell was rebuilt when the tab changed from DEMOS to CONSOLE');
  await typeLine('run smoke-web --tasks 3 --user smoke-user --spread');
  await until('its tasks to run', state(`(s.tasks || []).filter((t) => t.job_name === 'smoke-web' && t.state === 'running').length === 3`), 30000);
  await until('what the console printed', printed('/borg> run smoke-web --tasks 3[^]*smoke-web accepted[^]*smoke-web: all 3 tasks placed on/'), 15000);
  await until('its chips', `document.querySelectorAll('#w-cell .m .chip').length >= 3`);
  await fitsScreen('CONSOLE');
  await screenshot('console-job');
});

await step('console: with a quota set, a job that goes over it is refused', async () => {
  await typeLine('quota smoke-user prod 0.5');
  await until('the quota', printed('/smoke-user may ask for at most 0.5 CPU/'));
  await typeLine('run smoke-web-2 --user smoke-user --cpu 1');
  await until('the refusal', `/over quota/.test((document.querySelector('#k-out .ln.err') || {}).textContent || '')`);
  if (await evaluate(mine('.length !== 1'))) throw new Error('the refused job is in the cell');
  await typeLine('nonsense');
  await until('an unknown command is answered', printed('/There is no command "nonsense"/'));
  await screenshot('console-refused');
});

await step('console: shortcuts drain a machine and put it back, typing the command for you', async () => {
  await until('the prompt to be free', `!document.getElementById('k-form').classList.contains('busy')`, 20000);
  const cmd = await evaluate(`document.querySelector('#k-keys [data-cmd^="drain "]').dataset.cmd`);
  await click('#k-keys [data-cmd^="drain "]');
  await until('the command was typed for us', printed(`/borg> ${cmd}/`));
  await until('the machine to drain', `document.querySelector('#w-cell .m.draining, #w-cell .m.drained') !== null`, 15000);
  await fitsScreen('a machine that is draining');
  await screenshot('console-drain');
  await until('the shortcut to put it back', `document.querySelector('#k-keys [data-cmd^="undrain "]:not(:disabled)') !== null`, 15000);
  await click('#k-keys [data-cmd^="undrain "]');
  await until('the machine back in service', `document.querySelector('#w-cell .m.draining, #w-cell .m.drained') === null`, 15000);
});

await step('console: a machine that is taken down shows as DOWN, then comes back', async () => {
  const name = await evaluate(state(`(s.machines || []).map((m) => m.name).sort().pop()`));
  await typeLine(`fail ${name} 8`);
  await until('what the console printed', printed(`/${name} is down for 8 s/`));
  await until('the machine to show as DOWN', `document.querySelector('#w-cell .m.down') !== null`, 20000);
  await fitsScreen('a machine that is down');
  await screenshot('console-down');
  await until('the machine to come back', `document.querySelector('#w-cell .m.down') === null`, 40000);
  await until('its tasks to run again', state(`(s.tasks || []).filter((t) => t.job_name === 'smoke-web' && t.state === 'running').length === 3`), 40000);
});

await step('console: the scoring policy changes and is put back', async () => {
  const was = await evaluate(state('s.policy'));
  const to = was === 'best_fit' ? 'worst_fit' : 'best_fit';
  await typeLine(`policy ${to.replace('_', '-')}`);
  await until('the new policy', state(`s.policy === '${to}'`));
  await until('the shortcut shows it', `document.querySelector('#k-keys [data-cmd="policy ${to.replace('_', '-')}"].on') !== null`);
  await until('the prompt to be free', `!document.getElementById('k-form').classList.contains('busy')`, 20000);
  await click(`#k-keys [data-cmd="policy ${was.replace('_', '-')}"]`);
  await until('the old policy', state(`s.policy === '${was}'`));
});

await step('console: its quota and job are removed again', async () => {
  await typeLine('quota smoke-user prod off');
  await until('the quota gone', printed('/removed the production quota of smoke-user/'));
  await typeLine('rm smoke-web');
  await until('the job gone', mine('.length === 0'), 15000);
});

await step('no console errors or uncaught exceptions', async () => {
  if (errors.length) throw new Error(errors.join(' | '));
});

ws.close();
chrome.kill();
console.log(failures ? `FAILED (${failures})` : 'PASSED');
process.exit(failures ? 1 : 0);
