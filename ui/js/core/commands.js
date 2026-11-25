// The console's command language: what is typed at the borg> prompt. Pure functions (no DOM, no
// network): parse() turns a line into a request, or says in words what is wrong with it.

const NAME = /^[A-Za-z0-9._-]{1,40}$/;

// A priority band as typed -> [band, the priority a job gets when only the band is named].
const PRIORITY = {
  mon: ['monitoring', 300], monitoring: ['monitoring', 300],
  prod: ['production', 200], production: ['production', 200],
  batch: ['batch', 100],
  free: ['free', 0],
};
const POLICY = {
  hybrid: 'hybrid',
  best: 'best_fit', bestfit: 'best_fit', 'best-fit': 'best_fit', best_fit: 'best_fit',
  worst: 'worst_fit', worstfit: 'worst_fit', 'worst-fit': 'worst_fit', worst_fit: 'worst_fit',
};

// [name, how to type it, what it does]: the list `help` prints, in this order. The console is
// about 60 characters wide, so a line here stays under that.
export const COMMANDS = [
  ['run', 'run <name> [options]', 'start a job'],
  ['rm', 'rm <job> | rm all', 'remove one job, or all'],
  ['jobs', 'jobs', 'list the jobs'],
  ['drain', 'drain <machine>', 'empty it for maintenance'],
  ['undrain', 'undrain <machine>', 'put it back in service'],
  ['fail', 'fail <machine> [seconds]', 'take it down for a while'],
  ['quota', 'quota', 'list the quotas'],
  ['quota', 'quota <user> <band> <cpu|off>', 'set or remove a CPU quota'],
  ['policy', 'policy hybrid|best-fit|worst-fit', 'how a machine is picked'],
  ['reclaim', 'reclaim on|off', 'resource reclamation'],
  ['status', 'status', 'the cell in a few lines'],
  ['clear', 'clear', 'clear this screen'],
  ['help', 'help [command]', 'this list, or one command'],
];

// The options of `run`, for `help run`.
export const RUN_OPTIONS = [
  ['--tasks N', 'how many tasks, 1 to 40 (default 1)'],
  ['--cpu C', 'CPU cores each task asks for (0.25)'],
  ['--mem MB', 'memory each task asks for (128)'],
  ['--prio BAND', 'prod, batch, free or mon (prod)'],
  ['--user U', 'who owns the job (ann)'],
  ['--secs S', 'a batch job that ends after S seconds'],
  ['--spread', 'at most one task per machine'],
];

const fail = (error) => ({ error });

// "--tasks 3 --cpu=0.25 --spread web" -> {words: ['web'], flags: {tasks: '3', cpu: '0.25', spread: true}}
function split(tokens, booleans) {
  const words = [], flags = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('--')) {
      words.push(t);
      continue;
    }
    const eq = t.indexOf('=');
    const key = (eq > 0 ? t.slice(2, eq) : t.slice(2)).toLowerCase();
    if (eq > 0) flags[key] = t.slice(eq + 1);
    else if (booleans.includes(key)) flags[key] = true;
    else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) flags[key] = tokens[++i];
    else flags[key] = '';
  }
  return { words, flags };
}

function parseRun(tokens) {
  const { words, flags } = split(tokens, ['spread']);
  const alias = { ram: 'mem', memory: 'mem', priority: 'prio', seconds: 'secs', task: 'tasks' };
  const f = {};
  for (const [k, v] of Object.entries(flags)) {
    const key = alias[k] || k;
    if (!['tasks', 'cpu', 'mem', 'prio', 'user', 'secs', 'spread'].includes(key)) return fail(`run has no option --${k}. Type "help run" for the options`);
    if (v === '') return fail(`--${k} needs a value, for example --${k} ${{ tasks: '3', cpu: '0.25', mem: '128', prio: 'batch', user: 'bob', secs: '60' }[key]}`);
    f[key] = v;
  }
  if (words.length !== 1) return fail(words.length ? `a job has one name, without spaces (got: ${words.join(' ')})` : 'give the job a name, for example: run web --tasks 3');
  const name = words[0];
  if (!NAME.test(name)) return fail('a job name is made of letters, digits, ".", "_" and "-" (at most 40)');
  const user = f.user ?? 'ann';
  if (!NAME.test(user)) return fail('a user name is made of letters, digits, ".", "_" and "-"');

  const tasks = Number(f.tasks ?? 1), cpu = Number(f.cpu ?? 0.25), mem = Number(f.mem ?? 128);
  if (!Number.isInteger(tasks) || tasks < 1 || tasks > 40) return fail('--tasks must be a whole number from 1 to 40');
  if (!(cpu > 0) || cpu > 16) return fail('--cpu must be more than 0 and at most 16, for example 0.25');
  if (!Number.isInteger(mem) || mem < 16 || mem > 8192) return fail('--mem must be a whole number of MB from 16 to 8192');
  let secs = null;
  if (f.secs != null) {
    secs = Number(f.secs);
    if (!(secs >= 5 && secs <= 900)) return fail('--secs must be from 5 to 900');
  }
  // A job that ends by itself is batch work unless it says otherwise.
  const word = String(f.prio ?? (secs == null ? 'prod' : 'batch')).toLowerCase();
  if (!PRIORITY[word]) return fail('--prio must be prod, batch, free or mon');
  const [band, priority] = PRIORITY[word];
  return { cmd: 'run', spec: { name, user, tasks, cpu, mem, band, priority, secs, spread: !!f.spread } };
}

function parseQuota(args) {
  if (!args.length) return { cmd: 'quota' };
  if (args.length !== 3) return fail('type: quota <user> <band> <cpu>   for example: quota ann prod 0.5   (or "off" to remove it)');
  const [user, bandWord, amount] = args;
  if (!NAME.test(user) && user !== '*') return fail('a user name is made of letters, digits, ".", "_" and "-" ("*" means everyone else)');
  const band = PRIORITY[bandWord.toLowerCase()]?.[0];
  if (!band || band === 'free') return fail('the band must be prod, batch or mon (work at free priority never counts against a quota)');
  if (['off', 'none', 'rm', 'remove'].includes(amount.toLowerCase())) return { cmd: 'quota', user, band, remove: true };
  const cpu = Number(amount);
  if (!(cpu >= 0) || amount.trim() === '') return fail('the limit is a number of CPU cores, 0 or more, for example 0.5 (or "off" to remove it)');
  return { cmd: 'quota', user, band, cpu };
}

// One line as typed -> {cmd, …} or {error}. An empty line is {cmd: ''}.
export function parse(line) {
  const tokens = String(line || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { cmd: '' };
  const cmd = tokens[0].toLowerCase();
  const args = tokens.slice(1);
  switch (cmd) {
    case 'run':
      return parseRun(args);
    case 'rm':
    case 'remove':
      if (args.length !== 1) return fail('type: rm <job>   or: rm all');
      return { cmd: 'rm', name: args[0] };
    case 'jobs':
    case 'status':
    case 'clear':
      return args.length ? fail(`${cmd} takes nothing after it`) : { cmd };
    case 'help':
    case '?':
      return { cmd: 'help', topic: (args[0] || '').toLowerCase() };
    case 'drain':
    case 'undrain':
      if (args.length !== 1) return fail(`type: ${cmd} <machine>   for example: ${cmd} borglet-2`);
      return { cmd, machine: args[0] };
    case 'fail': {
      if (args.length < 1 || args.length > 2) return fail('type: fail <machine> [seconds]   for example: fail borglet-3 30');
      const seconds = args[1] == null ? 30 : Number(args[1]);
      if (!(seconds >= 5 && seconds <= 300)) return fail('a machine can be down for 5 to 300 seconds');
      return { cmd, machine: args[0], seconds };
    }
    case 'quota':
      return parseQuota(args);
    case 'policy': {
      const policy = POLICY[(args[0] || '').toLowerCase()];
      return args.length === 1 && policy ? { cmd, policy } : fail('type: policy hybrid   or: policy best-fit   or: policy worst-fit');
    }
    case 'reclaim': {
      const v = (args[0] || '').toLowerCase();
      return args.length === 1 && (v === 'on' || v === 'off') ? { cmd, on: v === 'on' } : fail('type: reclaim on   or: reclaim off');
    }
    default:
      return fail(`there is no command "${tokens[0]}". Type "help" for the list`);
  }
}

// The machine meant by a word: its full name, or just its number ("borglet-2", "m2", "2").
// Returns null when no machine, or more than one, matches.
export function findMachine(word, machines) {
  const w = String(word || '').toLowerCase();
  const list = machines || [];
  const exact = list.find((m) => m.name.toLowerCase() === w);
  if (exact) return exact;
  const n = /^(?:m|#)?(\d+)$/.exec(w);
  const hits = list.filter((m) => (n ? new RegExp(`(^|\\D)${n[1]}$`).test(m.name) : m.name.toLowerCase().includes(w)));
  return hits.length === 1 ? hits[0] : null;
}

// "web" when no job has that name, else "web-2", "web-3", …
export function freeName(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
