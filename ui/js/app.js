// The app's shared state: the REST client, the store that polls the cell, the quotas, and a
// way to ask for a redraw. main.js fills in `draw`.

import { makeApi } from './core/api.js';
import { Store } from './core/store.js';

// The poller's own client never retries: it asks again a second later anyway, and it has to
// see a 503 at once to show the "electing a new Borgmaster" banner.
const store = new Store(makeApi(''));

// Everything a click or a command triggers goes through this client: a 503 (the replicas are
// electing a new master) is retried for a few seconds, and the banner says so meanwhile.
const api = makeApi('', {
  retry503: 12,
  retryMs: 700,
  onElection: (waiting) => (waiting ? store.noteElection() : store.refresh()),
});

let queued = false;
let quotaAt = 0;
let quotaBusy = false;

export const app = {
  api,
  store,
  quotas: [],                 // GET /api/quota: [{user, band, cpu, ram_mb, disk_mb, used}]
  draw: () => {},             // set by main.js: draws the page now

  // Asks for a redraw; several requests in a row become one.
  render() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      app.draw();
    });
  },

  // Reads the quotas again. The state document does not carry them, so the views that show
  // them call this on every draw; `maxAge` keeps that to one request every few seconds.
  async refreshQuotas(maxAge = 0) {
    if (quotaBusy || Date.now() - quotaAt < maxAge) return;
    quotaBusy = true;
    quotaAt = Date.now();
    try {
      app.quotas = (await store.api.quota()).quotas || [];
      app.render();
    } catch {
      /* the header shows the connection state */
    } finally {
      quotaBusy = false;
    }
  },
};
