#!/usr/bin/env node
// Browser smoke test for the terminal UI: drives headless Chrome over the DevTools protocol
// through the main flows with real key presses, checks the result in the DOM and the API,
// saves a screenshot per step, and fails on any console error or uncaught exception.
//
//   docker compose up -d --build
//   node tests/ui/browser-smoke.mjs [http://localhost:8080] [out-dir]
//
// It deletes every job in the cell first. Set CHROME=/path/to/chrome if it is not found.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:8080';
const OUT = process.argv[3] || 'build/ui-smoke';
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
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
};

// ---- Chrome + CDP plumbing ----------------------------------------------------------------------
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'mb-smoke-'))}`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
let targets = [];
for (let i = 0; i < 50 && !targets.find((t) => t.type === 'page'); i++) {
  await sleep(200);
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { /* not up yet */ }
}
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/favicon/.test(msg.params.entry.url || '')) errors.push(msg.params.entry.text);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
const KEYS = {
  Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape'], Tab: [9, 'Tab'], ' ': [32, 'Space', ' '],
  ArrowDown: [40, 'ArrowDown'], ArrowUp: [38, 'ArrowUp'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
};
async function press(key) {
  const [code, name, text] = KEYS[key] || [key.toUpperCase().charCodeAt(0), `Key${key.toUpperCase()}`, key];
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: name, windowsVirtualKeyCode: code, text, unmodifiedText: text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: name, windowsVirtualKeyCode: code });
  await sleep(120);
}
const type = async (s) => { for (const ch of s) await press(ch); };
async function click(selector) {
  const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) throw new Error(`no element ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await sleep(200);
}
let shot = 0;
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT, `${String(++shot).padStart(2, '0')}-${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}
async function until(desc, expr, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(expr)) return true;
    await sleep(150);
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
const msg = () => evaluate(`document.getElementById('msgline').textContent`);
const setSize = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

// ---- scenario -------------------------------------------------------------------------------------
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await setSize(1600, 1000);
for (const j of (await api('GET', '/api/state')).jobs) await api('DELETE', `/api/jobs/${j.id}?purge=1`);
console.log(`browser smoke test against ${BASE} (screenshots in ${OUT})`);

await step('boot screen shows the cube and real start-up checks', async () => {
  await send('Page.navigate', { url: `${BASE}/?boot=full` });
  await until('boot log', `document.querySelectorAll('.bootlog .bl').length >= 3`);
  await screenshot('boot');
  await press('x'); // any key skips
  await until('app visible', `!document.getElementById('app').hidden`);
});

await step('home shows the empty state with presets', async () => {
  await until('presets', `document.querySelectorAll('.preset').length === 8`);
  await screenshot('home-empty');
});

await step('n opens the job form; Enter schedules the default preset', async () => {
  await press('n');
  await until('form', `!!document.querySelector('.drawer')`);
  await screenshot('form-new');
  await press('Enter');
  await until('scheduled message', `document.getElementById('msgline').textContent.includes('scheduled')`);
  const st = await api('GET', '/api/state');
  if (!st.jobs.some((j) => j.name === 'web-frontend')) throw new Error('job not in the API');
});

await step('a preset click + schedule button works with the mouse', async () => {
  await click('[data-act="view:home"]');
  await press('n');
  await until('form', `!!document.querySelector('.drawer')`);
  await click('[data-group="preset"] [data-v="analytics"]');
  await click('.drawer [data-act="submit"]');
  await until('second job', `document.getElementById('msgline').textContent.includes('analytics')`);
});

await step('home tracks progress live', async () => {
  await sleep(4500);
  await until('running rows', `document.querySelectorAll('#v-home .p-jobs tr[data-job]').length >= 2`);
  await screenshot('home-running');
});

await step('2 shows the jobs view with details of the selected job', async () => {
  await press('2');
  await until('detail', `document.querySelector('#v-jobs .p-detail .kv') !== null`);
  await screenshot('jobs');
});

await step(': opens the palette with ghost-text completion', async () => {
  await press(':');
  await type('resc');
  await until('palette', `!document.getElementById('palette').hidden && document.querySelector('.cmdline .ghost').textContent === 'hedule'`);
  await screenshot('palette');
  await press('Escape');
  await press('Escape');
  await until('nav mode', `document.documentElement.dataset.mode === 'nav'`);
});

await step('a typo gets a "did you mean"', async () => {
  await press(':');
  await type('scheduel');
  await press('Enter');
  const m = await msg();
  if (!m.includes('did you mean schedule')) throw new Error(m);
});

await step('? opens help; its filter narrows it', async () => {
  await press('?');
  await until('help', `!!document.querySelector('.dlg .help-grid')`);
  await type('prio');
  await screenshot('help');
  await press('Escape');
  await until('closed', `!document.querySelector('.dlg')`);
});

await step('e edits in place: priority 200 -> 300 without restarts', async () => {
  await click('[data-act="view:jobs"]');
  await evaluate(`(() => { const s = window.miniBorg.shell; const j = s.model.jobs.find((x) => x.name === 'web-frontend'); s.sel.job = j.id; s.render(); })()`);
  await press('e');
  await until('edit form', `!!document.querySelector('.drawer')`);
  await press('ArrowRight'); // focus starts on the checked priority band: prod -> monitoring
  await until('impact', `document.querySelector('[data-impact]').textContent.includes('in place')`);
  await screenshot('form-edit');
  await press('Enter');
  await until('updated', `document.getElementById('msgline').textContent.includes('updated web-frontend')`);
  const st = await api('GET', '/api/state');
  if (st.jobs.find((j) => j.name === 'web-frontend').priority !== 300) throw new Error('priority not changed');
});

await step('r reschedules: the dialog explains the effect; Enter restarts now', async () => {
  await press('r');
  await until('dialog', `!!document.querySelector('.dlg.danger [role=radio]')`);
  await screenshot('reschedule');
  await press('Enter'); // "now" is selected
  await until('done', `/restart now/.test(document.getElementById('msgline').textContent)`);
});

await step('d deletes (after choosing) and u undoes it', async () => {
  await press('d');
  await until('choice', `!!document.querySelector('.dlg [role=radio]')`);
  await screenshot('delete-dialog');
  await press('2');
  await press('Enter');
  await until('deleted', `document.getElementById('msgline').textContent.includes('deleted web-frontend')`);
  await press('u');
  await until('undone', `document.getElementById('msgline').textContent.includes('undone')`);
  const st = await api('GET', '/api/state');
  if (!st.jobs.some((j) => j.name === 'web-frontend')) throw new Error('undo did not resubmit');
});

await step('3 machines view; f asks before failing; n cancels', async () => {
  await press('3');
  await until('rows', `document.querySelectorAll('#v-machines tr[data-machine]').length >= 3`);
  await screenshot('machines');
  await press('f');
  await until('confirm', `!!document.querySelector('.dlg.danger')`);
  await screenshot('fail-confirm');
  await press('n');
  await until('cancelled', `document.getElementById('msgline').textContent.includes('cancelled')`);
});

await step('4 log view with kind chips', async () => {
  await press('4');
  await until('events', `document.querySelectorAll('#v-log .ev').length > 3`);
  await screenshot('log');
});

await step('5 simulation results', async () => {
  await press('5');
  await sleep(800);
  await screenshot('sim');
});

await step('space pauses live updates', async () => {
  await press('1');
  await press(' ');
  await until('paused', `document.querySelector('.statusbar').textContent.includes('PAUSED')`);
  await press(' ');
  await until('live', `document.querySelector('.statusbar').textContent.includes('LIVE')`);
});

await step('theme command switches the palette', async () => {
  await press(':');
  await type('theme amber');
  await press('Enter');
  await until('amber', `document.documentElement.dataset.theme === 'amber'`);
  await screenshot('theme-amber');
  await press(':');
  await type('theme mono');
  await press('Enter');
  await until('mono', `document.documentElement.dataset.theme === 'mono'`);
});

await step('narrow screen layout', async () => {
  await setSize(500, 1000);
  await sleep(600);
  await screenshot('narrow');
  await setSize(1600, 1000);
});

await step('no console errors or uncaught exceptions', async () => {
  if (errors.length) throw new Error(errors.join(' | '));
});

ws.close();
chrome.kill();
for (const j of (await api('GET', '/api/state')).jobs) await api('DELETE', `/api/jobs/${j.id}?purge=1`);
console.log(failures ? `FAILED (${failures})` : 'PASSED');
process.exit(failures ? 1 : 0);
