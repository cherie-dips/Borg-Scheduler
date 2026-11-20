// Borgmaster REST client. Every call resolves to data or throws an ApiError whose message is
// written for a person, not a log file.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('cannot reach the borgmaster. Is the cell running? (docker compose up -d)', 0);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) throw new ApiError(data.error || `the borgmaster answered HTTP ${res.status}`, res.status);
  return data;
}

export const api = {
  state: () => request('GET', '/api/state'),
  events: (since) => request('GET', `/api/events?since=${since}`),
  submit: (spec) => request('POST', '/api/jobs', spec),
  edit: (id, patch) => request('PATCH', `/api/jobs/${id}`, patch),
  reschedule: (id, delay) => request('POST', `/api/jobs/${id}/reschedule`, delay > 0 ? { delay } : {}),
  kill: (id) => request('DELETE', `/api/jobs/${id}`),           // live job: stop it, keep it in history
  remove: (id) => request('DELETE', `/api/jobs/${id}?purge=1`), // stop if needed, then forget it
  setPolicy: (policy) => request('POST', '/api/config', { policy }),
  fail: (machineId, seconds) => request('POST', `/api/machines/${machineId}/fail`, { seconds }),

  // Plan A results (CSV files served from results/); null when missing.
  async csv(name) {
    try {
      const res = await fetch(`/results/${name}.csv`, { cache: 'no-store' });
      return res.ok ? parseCsv(await res.text()) : null;
    } catch {
      return null;
    }
  },
};

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const head = lines.shift().split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(head.map((h, i) => {
      const v = cells[i] ?? '';
      return [h, v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v];
    }));
  });
}
