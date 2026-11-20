// Boot screen: the rotating Borg cube above real start-up checks (systemd style). Every line
// reports something true about the cell. Any key or click skips it; it never takes longer
// than ~2.5 s; with reduced motion the cube stands still.

import { WORDMARK, cubeHTML } from './cube.js';
import { esc, num } from '../lib/format.js';
import { $, h, reducedMotion } from '../lib/dom.js';

export function runBoot(store, mode = 'full', { replay = false } = {}) {
  if (mode === 'off' && !replay) return Promise.resolve();
  const quick = mode === 'quick' || reducedMotion();
  const root = document.getElementById('boot');
  root.hidden = false;
  root.className = 'boot';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'mini-borg is starting; press any key to skip');
  root.innerHTML = `
    <div class="boot-inner">
      <pre class="cube" aria-hidden="true"></pre>
      <div>
        <pre class="wordmark" role="img" aria-label="MINI-BORG">${esc(WORDMARK.join('\n'))}</pre>
        <p class="tagline">cluster manager · a working replica of Google's Borg (EuroSys '15)</p>
        <div class="bootlog" aria-live="polite"></div>
        <p class="skip">press any key or click to continue<span class="cursor"> </span></p>
      </div>
    </div>`;
  const cubeEl = $('.cube', root), log = $('.bootlog', root);
  const W = window.innerWidth < 760 ? 34 : 46, H = window.innerWidth < 760 ? 16 : 22;

  // Turntable spin: a fixed 40° tilt shows the top face; only the vertical axis turns.
  let A = -0.7, B = 0.5, raf = 0, last = 0, done = false;
  const frame = (t) => {
    if (done) return;
    if (t - last > 40) {
      B += 0.035;
      cubeEl.innerHTML = cubeHTML(A, B, W, H);
      last = t;
    }
    raf = requestAnimationFrame(frame);
  };
  if (reducedMotion()) cubeEl.innerHTML = cubeHTML(A, 0.65, W, H);
  else raf = requestAnimationFrame(frame);

  const line = (tag, text) => {
    const cls = { OK: 'ok', FAIL: 'fail', INFO: 'info' }[tag];
    log.append(h('div', { class: 'bl' }, `<span class="tag ${cls}">[${tag === 'OK' ? '  OK  ' : tag === 'FAIL' ? 'FAILED' : ' INFO '}]</span> ${text}`));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, quick ? ms / 3 : ms));

  return new Promise((resolve) => {
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
      root.removeEventListener('click', finish);
      root.classList.add('leaving');
      setTimeout(() => {
        root.hidden = true;
        root.innerHTML = '';
        resolve();
      }, 240);
    };
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      finish();
    };
    document.addEventListener('keydown', onKey, true);
    root.addEventListener('click', finish);

    (async () => {
      const t0 = performance.now();
      await wait(220);
      line('OK', `terminal ${Math.floor(window.innerWidth / 8.4)}×${Math.floor(window.innerHeight / 21)} · JetBrains Mono · theme ${document.documentElement.dataset.theme}`);
      // Wait for the first answer from the borgmaster (the store is already polling).
      const answered = await firstAnswer(store, 2200);
      if (done) return;
      const ms = Math.round(performance.now() - t0);
      if (answered && store.connected) {
        const m = store.model, r = m.raw;
        line('OK', `borgmaster at ${esc(location.host)} answered in ${ms} ms`);
        await wait(260);
        line('OK', `cell: ${m.counts.machinesUp}/${m.counts.machines} machines up · ${num(r.capacity.cpu)} cpu · ${Math.round(r.capacity.ram)} MB`);
        await wait(260);
        line('OK', `loaded ${m.jobs.length} job${m.jobs.length === 1 ? '' : 's'} · ${r.tasks.length} task${r.tasks.length === 1 ? '' : 's'} · ${m.counts.running} running`);
        await wait(240);
        line('OK', `scheduler policy ${esc(r.policy)}${r.scheduler?.elapsed_ms != null ? ` · last pass ${num(r.scheduler.elapsed_ms, 3)} ms` : ''}`);
      } else {
        line('FAIL', `no answer from the borgmaster: ${esc(store.error || 'timed out')}`);
        line('INFO', 'the console will keep retrying; start the cell with <b>docker compose up -d</b>');
      }
      await wait(220);
      const res = await store.loadResults();
      const n = Object.values(res).filter(Boolean).length;
      line(n ? 'OK' : 'INFO', n ? `simulation results: ${n} experiment files` : 'no simulation results yet (run borgsim to create them)');
      await wait(260);
      line('INFO', 'We are Borg. Your workloads will be assimilated.');
      await wait(quick ? 500 : 700);
      finish();
    })();
  });
}

function firstAnswer(store, timeout) {
  if (store.connected !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      off();
      resolve(false);
    }, timeout);
    const off = store.on((kind) => {
      if (kind === 'update') {
        clearTimeout(t);
        off();
        resolve(true);
      }
    });
  });
}
