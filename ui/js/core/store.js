// Polls the Borgmaster about once a second, keeps the derived model, and tells the page when
// something changed. It also knows how the connection is doing:
//   connecting  no answer yet            live      the Borgmaster answers
//   electing    it answers 503: the replicas are choosing a new master (retried every poll)
//   down        it does not answer at all

import { derive } from './model.js';

export class Store {
  constructor(api) {
    this.api = api;
    this.model = null;        // derive(state) of the last answer
    this.replica = null;      // GET /internal/replica: which Borgmaster serves this page
    this.link = 'connecting';
    this.listeners = new Set();
    this.ticks = 0;
  }

  on(fn) {
    this.listeners.add(fn);
  }

  emit(kind, data) {
    for (const fn of this.listeners) {
      try {
        fn(kind, data);
      } catch (e) {
        console.error(e); // a listener failed: report it, but never stop polling
      }
    }
  }

  get state() {
    return this.model?.raw || null;
  }

  start(intervalMs = 1000) {
    const tick = async () => {
      await this.refresh();
      setTimeout(tick, intervalMs);
    };
    tick();
  }

  setLink(link) {
    const from = this.link;
    this.link = link;
    if (from !== link) this.emit('link', { from, to: link });
  }

  // An action just got 503 and is being retried: show it without waiting for the next poll.
  noteElection() {
    if (this.link === 'live') this.setLink('electing');
  }

  // One refresh at a time; a call that arrives meanwhile shares the one in flight.
  refresh() {
    this.busy = this.busy || this.refreshOnce().finally(() => { this.busy = null; });
    return this.busy;
  }

  async refreshOnce() {
    this.ticks++;
    let state;
    try {
      // The replica is an extra: a failure there must not look like a lost connection.
      const [s, replica] = await Promise.all([
        this.api.state(),
        this.replica == null || this.ticks % 5 === 0 ? this.api.replica().catch(() => null) : null,
      ]);
      state = s;
      if (replica) this.replica = replica;
    } catch (e) {
      this.setLink(e.status === 503 ? 'electing' : 'down');
      this.emit('update');
      return;
    }
    const before = this.model?.raw.master;
    try {
      this.model = derive(state);
    } catch (e) {
      console.error(e); // an answer the page cannot read: keep showing the last good one
    }
    this.setLink('live');
    const master = state.master;
    if (before?.name && master?.name && before.name !== master.name) {
      this.replica = null; // ask again who serves this page
      this.emit('master', { name: master.name, election: master.election });
    }
    this.emit('update');
  }
}
