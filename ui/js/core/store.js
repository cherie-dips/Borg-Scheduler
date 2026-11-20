// Polls the Borgmaster, keeps the derived model, the event log and short usage histories, and
// tells the UI when something changed. Pausing stops applying new data (the demo freeze).

import { api } from './api.js';
import { derive, transitions } from './model.js';

const HISTORY = 90; // samples kept for sparklines (one per poll)

export class Store {
  constructor() {
    this.model = null;
    this.events = [];
    this.lastSeq = 0;
    this.offset = 0;          // server clock - browser clock, seconds
    this.connected = null;    // null until the first answer
    this.error = '';
    this.paused = false;
    this.history = { cpuAlloc: [], cpuUsed: [], machines: new Map() };
    this.results = null;      // simulation result CSVs, loaded on demand
    this.listeners = new Set();
    this.timer = null;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(kind, data) {
    for (const fn of this.listeners) fn(kind, data);
  }

  now() {
    return Date.now() / 1000 + this.offset;
  }

  start(intervalMs = 1000) {
    const tick = async () => {
      await this.refresh();
      this.timer = setTimeout(tick, intervalMs);
    };
    tick();
  }

  setPaused(p) {
    this.paused = p;
    this.emit('paused', p);
    if (!p) this.refresh();
  }

  async refresh() {
    if (this.paused) return;
    try {
      const [state, ev] = await Promise.all([api.state(), api.events(this.lastSeq)]);
      if (this.paused) return;
      this.offset = state.time - Date.now() / 1000;
      const prev = this.model;
      this.model = derive(state, state.time);
      this.record(state);
      let fresh = ev.events || [];
      if (ev.last < this.lastSeq) {
        // The master restarted and its event numbers began again: start over next poll.
        this.events = [];
        this.lastSeq = 0;
        fresh = [];
      } else {
        this.lastSeq = ev.last;
        this.events.push(...fresh);
        if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
      }
      const wasConnected = this.connected;
      this.connected = true;
      this.error = '';
      if (wasConnected === false) this.emit('reconnected');
      this.emit('update', { events: fresh, notes: transitions(prev, this.model) });
    } catch (e) {
      const changed = this.connected !== false;
      this.connected = false;
      this.error = e.message;
      if (changed) this.emit('disconnected', e.message);
      this.emit('update', { events: [], notes: [] });
    }
  }

  record(state) {
    const push = (arr, v) => {
      arr.push(v);
      if (arr.length > HISTORY) arr.shift();
    };
    const cap = state.capacity.cpu || 1;
    push(this.history.cpuAlloc, state.allocated.cpu / cap);
    push(this.history.cpuUsed, state.machines.reduce((s, m) => s + (m.status === 'up' ? m.usage.cpu : 0), 0) / cap);
    for (const m of state.machines) {
      if (!this.history.machines.has(m.id)) this.history.machines.set(m.id, []);
      push(this.history.machines.get(m.id), m.status === 'up' ? m.usage.cpu / (m.capacity.cpu || 1) : null);
    }
  }

  async loadResults(force = false) {
    if (this.results && !force) return this.results;
    const names = ['workload', 'policies', 'segregation', 'buckets', 'scalability', 'reclamation', 'hybrid_alpha'];
    const rows = await Promise.all(names.map((n) => api.csv(n)));
    this.results = Object.fromEntries(names.map((n, i) => [n, rows[i]]));
    return this.results;
  }
}
