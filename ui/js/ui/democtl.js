// Runs the guided demos (core/demos.js) for the page: one at a time, and keeps what each demo
// said, so the page can print its steps as they happen and show them again afterwards.

import { app } from '../app.js';
import { DemoRunner, demoByKey, describe } from '../core/demos.js';
import { capital } from '../lib/format.js';

const { api, store } = app;

// Machines a demo drained (and settings it changed) are remembered across a page reload, so
// "Clean up" can still put them back.
const KEY = 'mini-borg.demo-undo';
const storage = {
  get() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  },
  set(names) {
    try {
      localStorage.setItem(KEY, JSON.stringify(names));
    } catch {
      /* private mode: the list lives as long as the page */
    }
  },
};

const out = {
  // What the runner prints: numbered steps (" 3 ▸ …"), asides, a question for the presenter.
  line(text, cls) {
    const v = demos.view;
    if (!v || cls === 'hl' || cls === 'ok' || cls === 'err') return; // title and result are drawn from the view
    const m = /^\s*(\d+) ▸ (.*)$/s.exec(text);
    if (m) v.lines.push({ kind: 'say', text: m[2], stage: v.stage });
    else if (cls === 'ask') v.lines.push({ kind: 'ask', text: text.replace(/^\s*☛\s*/, ''), stage: v.stage });
    else v.lines.push({ kind: 'aside', text: text.trim(), stage: v.stage });
    app.render();
  },
  stage(n) {
    if (demos.view) demos.view.stage = n;
    app.render();
  },
  // The demo is about this job or this machine: the cell highlights it.
  point(kind, id) {
    if (!demos.view) return;
    demos.view.focus = { kind, id };
    app.render();
  },
  refresh: () => store.refresh(),
};

export const demos = {
  prefix: 'demo-',
  runner: new DemoRunner({ api, out, prefix: 'demo-', storage, minGap: 5 }),
  // The last run of each demo, by key, so its steps can be read again later:
  // {key, title, blurb, steps, stage, lines, status, result, stopping, focus, started, ended, cleaned}.
  // status: running | ok | failed | stopped
  runs: {},
  // The run that is going on, or the latest one.
  view: null,

  get running() {
    return this.runner.running;
  },

  async run(key) {
    const demo = demoByKey(key);
    if (!demo) return;
    if (this.runner.running || !store.model) return; // one at a time, and only on a cell that answers
    this.view = this.runs[demo.key] = { key: demo.key, title: demo.title, blurb: demo.blurb, steps: demo.steps, stage: 0, lines: [], status: 'running', result: '', stopping: false, focus: null, started: Date.now(), ended: 0, cleaned: false };
    // Starting a demo first clears what an earlier one left in the cell.
    for (const v of Object.values(this.runs)) if (v !== this.view) v.cleaned = true;
    app.render();
    const r = await this.runner.run(demo.key);
    const v = this.view;
    if (v && v.key === demo.key) {
      v.status = r.ok ? 'ok' : v.stopping ? 'stopped' : 'failed';
      v.result = capital(r.text.replace(/^demo \S+ /, ''));
      v.stopping = false;
      v.ended = Date.now();
    }
    await store.refresh();
    app.render();
  },

  stop() {
    if (!this.runner.stop()) return;
    if (this.view) this.view.stopping = true;
    app.render();
  },

  // Removes what the demos left in the cell; what they said stays readable. Resolves to a
  // sentence that says what was removed.
  async clean() {
    const left = describe(await this.runner.clean());
    for (const v of Object.values(this.runs)) if (v.status !== 'running') v.cleaned = true;
    return left ? `Cleaned up what the demos left: ${left}.` : 'Nothing to clean up: the demos left nothing behind.';
  },

  // What demos left in the cell: jobs named demo-… (so the page can offer "Clean up").
  leftovers() {
    return (store.state?.jobs || []).filter((j) => j.name.startsWith(this.prefix)).length;
  },

};
