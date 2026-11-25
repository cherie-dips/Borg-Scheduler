// Borgmaster REST client. Every call resolves to data or throws an ApiError whose message is
// written for a person, not a log file.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `base` is empty in the browser (same origin); tests and scripts pass the master's URL.
//
// A cell with several Borgmaster replicas answers 503 for a second or two while it elects a new
// master. With `retry503` > 0 a call that gets 503 is repeated that many times, `retryMs` apart;
// `onElection(true | false)` says when such a wait starts and ends, so a page can show a banner.
export function makeApi(base = '', { retry503 = 0, retryMs = 700, onElection = null } = {}) {
  async function once(method, path, body) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError('cannot reach the Borgmaster. Is the cell running?', 0);
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    if (!res.ok) throw new ApiError(data.error || `the Borgmaster answered HTTP ${res.status}`, res.status);
    return data;
  }

  async function request(method, path, body) {
    let waiting = false;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await once(method, path, body);
        } catch (e) {
          if (e.status !== 503 || attempt >= retry503) throw e;
          if (!waiting) onElection?.(true);
          waiting = true;
          await sleep(retryMs);
        }
      }
    } finally {
      if (waiting) onElection?.(false);
    }
  }

  return {
    state: () => request('GET', '/api/state'),
    events: (since) => request('GET', `/api/events?since=${since}`),
    submit: (spec) => request('POST', '/api/jobs', spec),
    edit: (id, patch) => request('PATCH', `/api/jobs/${id}`, patch),
    remove: (id) => request('DELETE', `/api/jobs/${id}?purge=1`), // stop the job if needed, then forget it
    setPolicy: (policy) => request('POST', '/api/config', { policy }),
    fail: (machineId, seconds) => request('POST', `/api/machines/${machineId}/fail`, { seconds }),

    // A job's open update: 'undo' rolls back to the spec before it, 'commit' keeps it for good.
    updateJob: (id, action) => request('POST', `/api/jobs/${id}/update`, { action }),
    // Reach into running server tasks: {action: sick | hang | ok | load | mem, index?, cpu?, mb?, seconds?}
    poke: (id, body) => request('POST', `/api/jobs/${id}/poke`, body),
    quota: () => request('GET', '/api/quota'),
    // {user, band, cpu?, ram_mb?, disk_mb?} sets a quota (a missing amount is unlimited); {remove: true} removes it.
    setQuota: (q) => request('POST', '/api/quota', q),
    drain: (machineId, maxDown) => request('POST', `/api/machines/${machineId}/drain`, maxDown > 0 ? { max_down: maxDown } : {}),
    undrain: (machineId) => request('POST', `/api/machines/${machineId}/undrain`, {}),
    setReclamation: (on, warmup) => request('POST', '/api/config',
      warmup >= 0 ? { reclamation: !!on, reclaim_warmup: warmup } : { reclamation: !!on }),
    // Which Borgmaster replica answers here: {name, elected, master, master_url}. Never passed on.
    replica: () => request('GET', '/internal/replica'),
  };
}
